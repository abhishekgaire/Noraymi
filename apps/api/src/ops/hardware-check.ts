import { listDevices, stationOf, venueReaders, type Queryable } from "@west4/db";
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

export async function hardwareEvidence(c: Queryable, venueId: string): Promise<HardwareEvidence> {
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
      ok: nfc > 0,
      detail: nfc > 0 ? "USB badge reader on the computer" : "no USB badge reader on the computer",
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
  lines.push({
    what: "Room tablets",
    ok: tabletProblems.length === 0,
    detail:
      tabletProblems.length > 0
        ? tabletProblems.join("; ")
        : `one per room, ${rooms.rows.length} rooms` +
          (outOfService.length > 0 ? ` (out of service: ${outOfService.join(", ")})` : ""),
  });

  const tv = live.find((d) => d.kind === "up_next_display");
  lines.push({
    what: "Up next TV",
    ok: !!tv?.online,
    detail: !tv ? "not paired" : tv.online ? `${tv.name}, online` : `${tv.name}, offline`,
  });

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
