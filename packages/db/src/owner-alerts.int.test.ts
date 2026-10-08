import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { insertRefund } from "./refunds.js";
import { withVenue } from "./tenancy.js";
import {
  appPool,
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "./test-helpers.js";

/**
 * M8-19: refunds over the venue's set amount alert the owner (every refund while it isn't set,
 * the cautious default), practice payments never do, and owner_alerts stays behind the venue wall.
 */
let db: TestDatabase;
let pool: pg.Pool;
let raw: pg.Client;
let v: TwoVenues;
const at = "2026-09-26T02:41:00Z";

async function paymentAt(venueId: string, training = false) {
  return (
    await raw.query<{ id: string }>(
      `insert into payments (venue_id, method, status, amount_cents, business_date, training)
       values ($1, 'cash', 'captured', 10000, '2026-09-25', $2) returning id`,
      [venueId, training],
    )
  ).rows[0]!.id;
}
let number = 9000;
const refund = async (venueId: string, paymentId: string, amountCents: number, by: string) => {
  const checkId = (
    await raw.query<{ id: string }>(
      `insert into checks (venue_id, number, kind, business_date, opened_by, status)
       values ($1, $2, 'bar', '2026-09-25', $3, 'paid') returning id`,
      [venueId, ++number, by],
    )
  ).rows[0]!.id;
  await withVenue(pool, { venueId }, (c) =>
    insertRefund(c, venueId, {
      id: randomUUID(),
      paymentId,
      checkId,
      bookingId: null,
      amountCents,
      reason: "drink spilled",
      requestedBy: by,
      approvalId: null,
      businessDate: "2026-09-25",
      adjustsBusinessDate: null,
      requestedAt: at,
    }),
  );
};
const alerts = async (venueId: string) =>
  (
    await raw.query<{ kind: string; amount_cents: string }>(
      "select kind, amount_cents from owner_alerts where venue_id = $1 order by amount_cents",
      [venueId],
    )
  ).rows;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  pool = appPool(db.url);
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  // Venue A sets $50.00; venue B sets nothing.
  await raw.query(
    `insert into venue_settings (venue_id, key, version, value, starts_on)
     values ($1, 'pos', 1, $2, '2026-01-01')`,
    [
      v.venueA,
      JSON.stringify({
        layouts: {},
        reasonOnly: { eachCents: 2500, perShiftCents: 7500 },
        idleLockMin: 3,
        wipeLockSec: 10,
        barTabTip: "reader",
        orderAging: { phonesSec: 30, amberSec: 120, pinkSec: 240, callSec: 360 },
        chime: true,
        muteSec: 60,
        refundAlertOverCents: 5000,
      }),
    ],
  );
});

afterAll(async () => {
  await pool.end();
  await raw.end();
  await db.drop();
});

describe("refunds alert the owner (M8-19)", () => {
  it("with no amount set, every refund alerts; a practice payment's never does", async () => {
    await refund(v.venueB, await paymentAt(v.venueB), 100, v.ownerB);
    await refund(v.venueB, await paymentAt(v.venueB, true), 9000, v.ownerB);
    expect(await alerts(v.venueB)).toEqual([{ kind: "refund", amount_cents: "100" }]);
    const push = await raw.query<{ payload: { audience: unknown; message: { key: string } } }>(
      "select payload from jobs where venue_id = $1 and kind = 'push.send'",
      [v.venueB],
    );
    expect(push.rows.map((r) => [r.payload.audience, r.payload.message.key])).toEqual([
      [{ kind: "role", role: "owner" }, "push.ownerAlert.refund"],
    ]);
  });

  it("with $50.00 set, only refunds over it alert", async () => {
    await refund(v.venueA, await paymentAt(v.venueA), 5000, v.ownerA);
    await refund(v.venueA, await paymentAt(v.venueA), 5001, v.ownerA);
    expect(await alerts(v.venueA)).toEqual([{ kind: "refund", amount_cents: "5001" }]);
  });

  it("owner_alerts is forced behind the venue wall", async () => {
    const forced = await raw.query<{ relforcerowsecurity: boolean }>(
      "select relforcerowsecurity from pg_class where relname = 'owner_alerts'",
    );
    expect(forced.rows[0]!.relforcerowsecurity).toBe(true);
    const seen = await withVenue(pool, { venueId: v.venueA }, (c) =>
      c.query<{ venue_id: string }>("select venue_id from owner_alerts"),
    );
    expect(seen.rows.length).toBeGreaterThan(0);
    expect(seen.rows.every((r) => r.venue_id === v.venueA)).toBe(true);
    await expect(
      withVenue(pool, { venueId: v.venueA }, (c) =>
        c.query(
          `insert into owner_alerts (venue_id, kind, source_key, amount_cents, business_date, created_at)
           values ($1, 'refund', 'refund:x', 1, '2026-09-25', now())`,
          [v.venueB],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
