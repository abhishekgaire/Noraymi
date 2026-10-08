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
