import {
  listDevices,
  stationOf,
  statesOf,
  venueModules,
  venueReaders,
  type Queryable,
} from "@west4/db";
import { stateOf } from "@west4/shared";
import { deviceHealth } from "../console/routes.js";

/**
 * The install day's device check (M9-07; docs/runbooks/hardware-install.md): what the venue's
 * device rows say against the hardware spec 09 · Devices at West 4 lists for a venue with a bar
 * and a front desk. Read-only. It checks only what our records can show; the physical lines
 * (a drawer opening, a tablet in kiosk mode, the cellular check) stay with the people on site.
 *
 * Every pay point (bar, front desk) needs: an S710 with cellular on, registered with Stripe,
 * labeled "<Bar|Front desk> S710" and online; a receipt printer online with that station's
 * drawer on its kick port; a USB badge reader on that station's computer. Every room needs
 * one paired tablet, online unless the room is out of service. Plus the Up next TV and the
 * router with its backup internet on. The health line printed is the one Admin and the
 * Console both show, from the same function and the same rows.
 */
export interface HardwareLine {
  readonly what: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface HardwareEvidence {
  readonly lines: readonly HardwareLine[];
  readonly health: ReturnType<typeof deviceHealth>;
  readonly ok: boolean;
}

const STATIONS = [
  { station: "bar", label: "Bar S710", computer: "bar_computer", name: "Bar" },
  { station: "front_desk", label: "Front desk S710", computer: "front_desk", name: "Front desk" },
] as const;

/**
 * Which hardware a venue is checked against (W-05): `west4`, the default, is the list above;
 * `bar-computers` is a venue that runs on its bar computers alone (D126, D127), as Sing Sing does:
 * at least one bar computer with the desktop app, the bar's receipt printer with the drawer on its
 * kick port, the kitchen printer when Kitchen & food is on (cabled to a bar computer, on the
 * venue's network or a cloud printer), and a card reader unless the outside card machine is on.
 * No front desk, room tablets, badge readers, staff phones, Up next TV or router are asked for.
 */
export type HardwareSet = "west4" | "bar-computers";
export const HARDWARE_SETS: readonly HardwareSet[] = ["west4", "bar-computers"];

async function moduleOn(c: Queryable, venueId: string, moduleId: string): Promise<boolean> {
  const r = await c.query<{ state: string }>(
    "select state from venue_modules where venue_id = $1 and module_id = $2",
    [venueId, moduleId],
  );
  const state = r.rows[0]?.state;
  return state === "on" || state === "stopping";
}

/** The bar-computers set (W-05). */
async function barComputerLines(c: Queryable, venueId: string): Promise<HardwareLine[]> {
  const devices = (await listDevices(c, venueId)).filter((d) => d.revoked_at === null);
  const lines: HardwareLine[] = [];
  const computers = devices.filter((d) => d.kind === "bar_computer");
  const desktop = computers.filter((d) => d.app_version !== null && d.app_version !== "web");
  lines.push({
    what: "Bar computers",
    ok: desktop.some((d) => d.online),
    detail:
      computers.length === 0
        ? "no bar computer paired"
        : computers
            .map(
              (d) =>
                `${d.name}: ${d.app_version === null || d.app_version === "web" ? "not the desktop app" : `desktop app ${d.app_version}`}, ${d.online ? "online" : "offline"}`,
            )
            .join("; "),
  });
  const drawers = await c.query<{ name: string; printer: string; printer_online: boolean | null }>(
    `select dr.name, p.name as printer,
            (h.last_seen_at is not null and h.offline_since is null) as printer_online
       from cash_drawers dr
       join devices p on p.venue_id = dr.venue_id and p.id = dr.printer_device_id
            and p.kind = 'printer' and p.revoked_at is null
       left join device_heartbeats h on h.venue_id = p.venue_id and h.device_id = p.id
      where dr.venue_id = $1 and dr.station = 'bar'`,
    [venueId],
  );
  const drawer = drawers.rows.find((d) => d.printer_online) ?? drawers.rows[0];
  lines.push({
    what: "Bar receipt printer and drawer",
    ok: drawer?.printer_online === true,
    detail: !drawer
      ? "no drawer on a receipt printer's kick port"
      : drawer.printer_online
        ? `${drawer.name} on ${drawer.printer}, online`
        : `${drawer.name}: ${drawer.printer} is offline`,
  });
  if (await moduleOn(c, venueId, "kitchen")) {
    const kitchen = devices.filter((d) => d.kind === "printer" && d.station === "kitchen");
    const up = kitchen.find((d) => d.online);
    const how = (d: (typeof kitchen)[number]) =>
      d.protocol === "usb"
        ? `cabled to ${devices.find((h) => h.id === d.host_device_id)?.name ?? "a computer"}`
        : d.protocol === "lan"
          ? `network printer at ${d.network_address}:${d.network_port}`
          : "cloud printer";
    lines.push({
      what: "Kitchen printer",
      ok: !!up,
      detail:
        kitchen.length === 0
          ? "no printer on the kitchen station"
          : kitchen
              .map((d) => `${d.name} (${how(d)}), ${d.online ? "online" : "offline"}`)
              .join("; "),
    });
  }
  if (await moduleOn(c, venueId, "outside_card")) {
    lines.push({
      what: "Card payments",
      ok: true,
      detail: "on the venue's outside card machine (card readers optional)",
    });
  } else {
    const readers = (await venueReaders(c, venueId)).filter((r) => !r.sandbox);
    const ready = readers.filter((r) => r.stripe_reader_id && r.online);
    lines.push({
      what: "Card payments",
      ok: ready.length > 0,
      detail:
        ready.length > 0
          ? ready.map((r) => `${r.name}, online`).join("; ")
          : "no card reader registered with Stripe and online, and the outside card machine is off",
    });
  }
  return lines;
}

export async function hardwareEvidence(
  c: Queryable,
  venueId: string,
  set: HardwareSet = "west4",
): Promise<HardwareEvidence> {
  if (set === "bar-computers") {
    const lines = await barComputerLines(c, venueId);
    const health = deviceHealth(await listDevices(c, venueId));
    return { lines, health, ok: lines.every((l) => l.ok) };
  }
  const devices = await listDevices(c, venueId);
  const live = devices.filter((d) => d.revoked_at === null);
  const readers = (await venueReaders(c, venueId)).filter((r) => !r.sandbox);
  const drawers = await c.query<{
    name: string;
    station: string | null;
    printer_online: boolean | null;
  }>(
    `select dr.name, dr.station,
            (h.last_seen_at is not null and h.offline_since is null) as printer_online
       from cash_drawers dr
       left join devices p on p.venue_id = dr.venue_id and p.id = dr.printer_device_id
            and p.kind = 'printer' and p.revoked_at is null
       left join device_heartbeats h on h.venue_id = p.venue_id and h.device_id = p.id
      where dr.venue_id = $1 and p.id is not null`,
    [venueId],
  );
  const hosts = await c.query<{ kind: string; nfc: number }>(
    `select host.kind, count(n.id)::int as nfc
       from devices host
       left join devices n on n.venue_id = host.venue_id and n.host_device_id = host.id
            and n.kind = 'nfc_reader' and n.revoked_at is null
      where host.venue_id = $1 and host.kind in ('bar_computer', 'front_desk') and host.revoked_at is null
      group by host.kind`,
    [venueId],
  );
  const rooms = await c.query<{ id: string; name: string; out_of_service: boolean }>(
    `select r.id, r.name, coalesce(s.state = 'out_of_service', false) as out_of_service
       from rooms r left join room_states s on s.venue_id = r.venue_id and s.room_id = r.id
      where r.venue_id = $1 order by r.name`,
    [venueId],
  );

  // What the venue runs (D126): a venue on its bar computers alone has no room tablets, no Up next
  // TV and no badges, so the check doesn't ask for them; a venue with a kitchen needs its printer.
  const on = statesOf(await venueModules(c, venueId));
  const tabletsOn = stateOf(on, "room_tablets") !== "off";
  const tvOn = stateOf(on, "bar_mode") !== "off";
  const kitchenOn = stateOf(on, "kitchen") !== "off";
  const badges =
    (
      await c.query<{ n: number }>(
        "select count(*)::int as n from staff_badges where venue_id = $1 and disabled_at is null",
        [venueId],
      )
    ).rows[0]?.n ?? 0;

  const lines: HardwareLine[] = [];
  for (const s of STATIONS) {
    const r = readers.find((x) => stationOf(x.station, x.name) === s.station);
    const problems = !r
      ? ["no reader"]
      : [
          r.name !== s.label ? `labeled "${r.name}", not "${s.label}"` : "",
          r.stripe_reader_id ? "" : "not registered with Stripe",
          r.cellular === true ? "" : "cellular not on",
          r.online ? "" : "offline",
        ].filter(Boolean);
    lines.push({
      what: `${s.name} reader`,
      ok: problems.length === 0,
      detail: problems.length === 0 ? `${r!.name}, cellular on, online` : problems.join("; "),
    });
    const drawer = drawers.rows.find((d) => d.station === s.station);
    lines.push({
      what: `${s.name} drawer`,
      ok: !!drawer && drawer.printer_online === true,
      detail: !drawer
        ? "no drawer on a receipt printer's kick port"
        : drawer.printer_online
          ? `${drawer.name} on an online receipt printer`
          : `${drawer.name}: its receipt printer is offline`,
    });
    const nfc = hosts.rows.find((h) => h.kind === s.computer)?.nfc ?? 0;
    lines.push({
      what: `${s.name} badge reader`,
      ok: nfc > 0 || badges === 0,
      detail:
        nfc > 0
          ? "USB badge reader on the computer"
          : badges === 0
            ? "not used: no badges issued, staff sign in with their PIN"
            : "no USB badge reader on the computer",
    });
  }

  const tablets = live.filter((d) => d.kind === "room_tablet");
  const tabletProblems: string[] = [];
  for (const room of rooms.rows) {
    const mine = tablets.filter((t) => t.room_id === room.id);
    if (mine.length === 0) tabletProblems.push(`${room.name}: no tablet`);
    else if (mine.length > 1) tabletProblems.push(`${room.name}: ${mine.length} tablets`);
    else if (!mine[0]!.online && !room.out_of_service) tabletProblems.push(`${room.name}: offline`);
  }
  const outOfService = rooms.rows.filter((r) => r.out_of_service).map((r) => r.name);
  lines.push(
    tabletsOn
      ? {
          what: "Room tablets",
          ok: tabletProblems.length === 0,
          detail:
            tabletProblems.length > 0
              ? tabletProblems.join("; ")
              : `one per room, ${rooms.rows.length} rooms` +
                (outOfService.length > 0 ? ` (out of service: ${outOfService.join(", ")})` : ""),
        }
      : { what: "Room tablets", ok: true, detail: "not used: Room tablets is off" },
  );

  const tv = live.find((d) => d.kind === "up_next_display");
  lines.push(
    tvOn
      ? {
          what: "Up next TV",
          ok: !!tv?.online,
          detail: !tv ? "not paired" : tv.online ? `${tv.name}, online` : `${tv.name}, offline`,
        }
      : { what: "Up next TV", ok: true, detail: "not used: Bar mode is off" },
  );

  if (kitchenOn) {
    const kitchen = live.filter((d) => d.kind === "printer" && d.station === "kitchen");
    lines.push({
      what: "Kitchen printer",
      ok: kitchen.some((p) => p.online),
      detail:
        kitchen.length === 0
          ? "no kitchen printer paired"
          : kitchen.some((p) => p.online)
            ? `${kitchen.find((p) => p.online)!.name}, online`
            : `${kitchen[0]!.name}, offline`,
    });
  }

  const health = deviceHealth(devices);
  lines.push({
    what: "Router",
    ok: health.router?.online === true && health.router.backup_internet === "on",
    detail: !health.router
      ? "not paired"
      : `${health.router.online ? "online" : "offline"}, backup internet ${health.router.backup_internet ?? "unknown"}`,
  });

  return { lines, health, ok: lines.every((l) => l.ok) };
}

/** The check as Markdown, for the install record (docs/runbooks/hardware-install.md). */
export function hardwareReport(slug: string, e: HardwareEvidence): string {
  const h = e.health;
  return [
    `# Device check · ${slug}`,
    "",
    "| | | |",
    "| --- | --- | --- |",
    ...e.lines.map((l) => `| ${l.what} | ${l.ok ? "OK" : "**Not yet**"} | ${l.detail} |`),
    "",
    "What Admin → Printers & devices and the Console both show:",
    "",
    `- ${h.tablets.online} of ${h.tablets.total} room tablets online`,
    `- ${h.readers.online} of ${h.readers.total} readers online`,
    `- Backup internet · ${h.router?.backup_internet ?? "unknown"}`,
    "",
    e.ok
      ? "Every device the records can show is in place."
      : "Not ready: fix every line marked Not yet.",
    "",
  ].join("\n");
}
