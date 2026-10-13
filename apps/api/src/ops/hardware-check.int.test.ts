import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listDevices, loadDemoSeed, withVenue } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { deviceHealth } from "../console/routes.js";
import { hardwareEvidence, hardwareReport } from "./hardware-check.js";

/**
 * M9-07: the install day's device check, on the demo seed (West 4 as installed) and with
 * pieces missing. The physical checks (cellular payments, drawer kicks, kiosk mode) are the
 * runbooks' to do on site.
 */
let db: TestDatabase;
let owner: pg.Client;
let pool: pg.Pool;
let venueId: string;

const check = () =>
  withVenue(pool, { venueId, requestId: "test" }, (c) => hardwareEvidence(c, venueId));

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  owner = new pg.Client({ connectionString: db.url });
  await owner.connect();
  pool = new pg.Pool({ connectionString: db.url, max: 2 });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  // What stripe:seed does after the seed: both readers registered with Stripe.
  await owner.query(
    "update devices set stripe_reader_id = 'tmr_' || md5(name) where venue_id = $1 and kind = 'reader' and not sandbox",
    [venueId],
  );
});

afterAll(async () => {
  await pool.end();
  await owner.end();
  await db.drop();
});

describe("the device check (M9-07)", () => {
  it("passes for West 4 as the seed installs it, with the health line Admin and the Console share", async () => {
    const e = await check();
    expect(e.lines.filter((l) => !l.ok)).toEqual([]);
    expect(e.ok).toBe(true);
    expect(e.lines.map((l) => l.what)).toEqual([
      "Bar reader",
      "Bar drawer",
      "Bar badge reader",
      "Front desk reader",
      "Front desk drawer",
      "Front desk badge reader",
      "Room tablets",
      "Up next TV",
      "Router",
    ]);
    expect(e.lines.find((l) => l.what === "Room tablets")!.detail).toBe(
      "one per room, 14 rooms (out of service: Room 4)",
    );
    const report = hardwareReport("west4karaoke", e);
    expect(report).toContain("- 13 of 14 room tablets online");
    expect(report).toContain("- 2 of 2 readers online");
    expect(report).toContain("- Backup internet · on");
    // The same function and rows the Console's venue list uses.
    const rows = await withVenue(pool, { venueId, requestId: "test" }, (c) =>
      listDevices(c, venueId),
    );
    expect(e.health).toEqual(deviceHealth(rows));
  });

  it("names each thing not yet in place: a reader without cellular, a tablet offline in a room in service, no TV", async () => {
    await owner.query(
      "update devices set cellular = false where venue_id = $1 and kind = 'reader' and name = 'Front desk S710'",
      [venueId],
    );
    await owner.query(
      `update device_heartbeats set offline_since = now() where venue_id = $1 and device_id =
         (select id from devices where venue_id = $1 and name = 'Tablet · Room 2')`,
      [venueId],
    );
    await owner.query(
      "update devices set revoked_at = now() where venue_id = $1 and kind = 'up_next_display'",
      [venueId],
    );
    const e = await check();
    expect(e.ok).toBe(false);
    expect(e.lines.filter((l) => !l.ok)).toEqual([
      { what: "Front desk reader", ok: false, detail: "cellular not on" },
      { what: "Room tablets", ok: false, detail: "Room 2: offline" },
      { what: "Up next TV", ok: false, detail: "not paired" },
    ]);
    expect(hardwareReport("west4karaoke", e)).toContain(
      "Not ready: fix every line marked Not yet.",
    );
  });
});

describe("a venue on its bar computers alone (W-05; Sing Sing's set)", () => {
  const checkSet = () =>
    withVenue(pool, { venueId, requestId: "test" }, (c) =>
      hardwareEvidence(c, venueId, "bar-computers"),
    );
  const barComputer = async () =>
    (
      await owner.query<{ id: string }>(
        "select id from devices where venue_id = $1 and kind = 'bar_computer' and revoked_at is null limit 1",
        [venueId],
      )
    ).rows[0]!.id;

  it("asks for no front desk, tablets, badge readers, phones or TV, and names a missing kitchen printer", async () => {
    // The desktop app on the bar computer, online.
    await owner.query(
      `insert into device_heartbeats (device_id, venue_id, last_seen_at, app_version)
       values ($2, $1, now(), '1.4.0')
       on conflict (device_id) do update set last_seen_at = now(), offline_since = null, app_version = '1.4.0'`,
      [venueId, await barComputer()],
    );
    await owner.query(
      `insert into venue_modules (venue_id, module_id, state) values ($1, 'kitchen', 'on')
       on conflict (venue_id, module_id) do update set state = 'on'`,
      [venueId],
    );
    const e = await checkSet();
    expect(e.lines.map((l) => l.what)).toEqual([
      "Bar computers",
      "Bar receipt printer and drawer",
      "Kitchen printer",
      "Card payments",
    ]);
    expect(e.lines.find((l) => l.what === "Kitchen printer")).toEqual({
      what: "Kitchen printer",
      ok: false,
      detail: "no printer on the kitchen station",
    });
    expect(e.ok).toBe(false);
  });

  it("passes with the kitchen printer cabled to the bar computer and online", async () => {
    const host = await barComputer();
    const k = await owner.query<{ id: string }>(
      `insert into devices (venue_id, kind, name, host_device_id, serial, station, protocol, command_set)
       values ($1, 'printer', 'Kitchen RP326', $2, 'win|Kitchen RP326', 'kitchen', 'usb', 'escpos') returning id`,
      [venueId, host],
    );
    await owner.query(
      "insert into device_heartbeats (device_id, venue_id, last_seen_at) values ($2, $1, now())",
      [venueId, k.rows[0]!.id],
    );
    const e = await checkSet();
    expect(e.lines.filter((l) => !l.ok)).toEqual([]);
    expect(e.ok).toBe(true);
    expect(e.lines.find((l) => l.what === "Kitchen printer")!.detail).toMatch(
      /^Kitchen RP326 \(cabled to .+\), online$/,
    );
    // West 4's own set still asks for everything it did.
    expect((await check()).lines.map((l) => l.what)).toContain("Room tablets");
  });

  it("without the outside card machine, a card reader online is needed", async () => {
    await owner.query(
      "update devices set revoked_at = now() where venue_id = $1 and kind = 'reader'",
      [venueId],
    );
    const e = await checkSet();
    expect(e.lines.filter((l) => !l.ok)).toEqual([
      {
        what: "Card payments",
        ok: false,
        detail:
          "no card reader registered with Stripe and online, and the outside card machine is off",
      },
    ]);
  });
});
