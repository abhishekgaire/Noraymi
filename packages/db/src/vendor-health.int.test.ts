import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { withVenue } from "./tenancy.js";
import {
  overallVendorCalls,
  recordVendorCall,
  setVendorHealth,
  venueVendorCalls,
  venueVendorHealth,
} from "./vendor-health.js";
import {
  appPool,
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "./test-helpers.js";

/** M8-01: vendor_calls and vendor_health behind the venue wall; the overall rate names no venue. */
let db: TestDatabase;
let pool: pg.Pool;
let v: TwoVenues;
const at = "2026-09-26T02:41:20Z";
const since = "2026-09-26T02:36:00Z";
const inVenue = <T>(venueId: string, work: (c: pg.PoolClient) => Promise<T>) =>
  withVenue(pool, { venueId, requestId: "test" }, work as never) as Promise<T>;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  pool = appPool(db.url);
});

afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe("vendor health (M8-01)", () => {
  it("counts calls per venue and minute, and venue B never sees venue A's", async () => {
    for (const failed of [true, true, false])
      await inVenue(v.venueA, (c) => recordVendorCall(c, v.venueA, "stripe", at, failed));
    await inVenue(v.venueB, (c) => recordVendorCall(c, v.venueB, "twilio", at, true));
    const a = await inVenue(v.venueA, (c) => venueVendorCalls(c, v.venueA, since));
    expect(a).toEqual([
      { vendor: "stripe", calls: 3, errors: 2 },
      { vendor: "twilio", calls: 0, errors: 0 },
    ]);
    // Venue B's context asking for venue A's rows gets nothing, and can't write them.
    const leak = await inVenue(v.venueB, (c) =>
      c.query("select * from vendor_calls where venue_id = $1", [v.venueA]),
    );
    expect(leak.rows).toEqual([]);
    await expect(
      inVenue(v.venueB, (c) => recordVendorCall(c, v.venueA, "stripe", at, true)),
    ).rejects.toThrow(/row-level security/);
  });

  it("adds every venue together for the overall rate, naming none", async () => {
    const overall = await overallVendorCalls(pool, since);
    expect(overall).toEqual([
      { vendor: "stripe", calls: 3, errors: 2 },
      { vendor: "twilio", calls: 1, errors: 1 },
    ]);
  });

  it("raises vendor.health only when trouble starts or ends, behind the wall", async () => {
    const set = (trouble: boolean) =>
      inVenue(v.venueA, (c) =>
        setVendorHealth(
          c,
          v.venueA,
          "stripe",
          { trouble, source: trouble ? "venue_errors" : null },
          at,
        ),
      );
    expect(await set(true)).toBe(true);
    expect(await set(true)).toBe(false);
    const health = await inVenue(v.venueA, (c) => venueVendorHealth(c, v.venueA));
    expect(health.stripe).toMatchObject({ trouble: true, source: "venue_errors" });
    expect(health.twilio.trouble).toBe(false);
    const other = await inVenue(v.venueB, (c) => venueVendorHealth(c, v.venueB));
    expect(other.stripe.trouble).toBe(false);
    expect(await set(false)).toBe(true);
    const events = await inVenue(v.venueA, (c) =>
      c.query<{ type: string }>("select type from venue_events where type = 'vendor.health'"),
    );
    expect(events.rows).toHaveLength(2);
  });
});
