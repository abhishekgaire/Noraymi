import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  generateSigningKey,
  insertPayment,
  loadDemoSeed,
  publishRulePack,
  withVenue,
  type Queryable,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import {
  expirePrepaid,
  issuePrepaid,
  prepaidBalance,
  redeemPrepaid,
  refundPrepaid,
} from "../payments/prepaid.js";
import { checkView } from "../rooms/checks.js";
import { mergeSessions } from "../rooms/merge.js";

/** The prepaid-value ledger and session merges (M4-28): service functions, no route and no screen. */
let db: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let venueId: string;
let ids: Record<string, string>;
const at = SEED_NOW.toString();
const night = "2026-09-25";
const inVenue = <T>(work: (c: Queryable) => Promise<T>) => withVenue(app, { venueId }, work);
const ledgerSum = async (account: string) =>
  Number(
    (
      await owner.query(
        "select coalesce(sum(amount_cents), 0) as s from prepaid_ledger where account_id = $1",
        [account],
      )
    ).rows[0].s,
  );

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  app = appPool(db.url);
  const key = generateSigningKey().privateKeyPem;
  for (const pack of [newYorkCounty, newYorkCountyTaxed])
    await publishRulePack(owner, {
      pack,
      effectiveOn: "2026-09-01",
      approvedBy: ["A", "B"],
      privateKeyPem: key,
    });
  ids = Object.fromEntries(
    (
      await owner.query<{ slug: string; id: string }>("select slug, row_id as id from seed_ids")
    ).rows.map((r) => [r.slug, r.id]),
  );
});

afterAll(async () => {
  await app.end();
  await owner.end();
  await db.drop();
});

describe("the prepaid-value ledger", () => {
  it("issue $50.00, redeem $30.00, expire $5.00, refund $15.00: $50.00, $20.00, $15.00, $0.00", async () => {
    const by = ids["andy"]!;
    const account = await inVenue((c) =>
      issuePrepaid(c, venueId, {
        kind: "gift_card",
        amountCents: 5000,
        paymentId: null,
        by,
        at,
        businessDate: night,
      }),
    );
    const steps: number[] = [await inVenue((c) => prepaidBalance(c, venueId, account))];
    await inVenue((c) =>
      redeemPrepaid(c, venueId, {
        accountId: account,
        checkId: ids["chk_room9"]!,
        amountCents: 3000,
        by,
        at,
        businessDate: night,
      }),
    );
    steps.push(await inVenue((c) => prepaidBalance(c, venueId, account)));
    await inVenue((c) =>
      expirePrepaid(c, venueId, {
        accountId: account,
        amountCents: 500,
        by,
        at,
        businessDate: night,
      }),
    );
    steps.push(await inVenue((c) => prepaidBalance(c, venueId, account)));
    await inVenue((c) =>
      refundPrepaid(c, venueId, {
        accountId: account,
        amountCents: 1500,
        by,
        at,
        businessDate: night,
      }),
    );
    steps.push(await inVenue((c) => prepaidBalance(c, venueId, account)));
    expect(steps).toEqual([5000, 2000, 1500, 0]);
    expect(await ledgerSum(account)).toBe(0);
    // The redemption is a prepaid payment allocated to the check.
    const paid = await owner.query(
      `select p.method, a.amount_cents::int from payments p join payment_allocations a on a.payment_id = p.id
        where p.method = 'prepaid' and a.check_id = $1`,
      [ids["chk_room9"]],
    );
    expect(paid.rows).toEqual([{ method: "prepaid", amount_cents: 3000 }]);
  });

  it("redeeming more than the balance is refused", async () => {
    const account = await inVenue((c) =>
      issuePrepaid(c, venueId, {
        kind: "song_credit",
        amountCents: 1000,
        paymentId: null,
        by: null,
        at,
        businessDate: night,
      }),
    );
    await expect(
      inVenue((c) =>
        redeemPrepaid(c, venueId, {
          accountId: account,
          checkId: ids["chk_room9"]!,
          amountCents: 1001,
          by: null,
          at,
          businessDate: night,
        }),
      ),
    ).rejects.toThrow(/more than the balance/);
    expect(await ledgerSum(account)).toBe(1000);
  });

  it("over 200 random moves, the balance is always the ledger's sum and never below zero", async () => {
    const account = await inVenue((c) =>
      issuePrepaid(c, venueId, {
        kind: "stored_value",
        amountCents: 20000,
        paymentId: null,
        by: null,
        at,
        businessDate: night,
      }),
    );
    let seed = 42;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 200; i++) {
      const amount = 1 + Math.floor(next() * 1500);
      const move = next() < 0.5 ? "refund" : "expire";
      await inVenue((c) =>
        move === "refund"
          ? refundPrepaid(c, venueId, {
              accountId: account,
              amountCents: amount,
              by: null,
              at,
              businessDate: night,
            })
          : expirePrepaid(c, venueId, {
              accountId: account,
              amountCents: amount,
              by: null,
              at,
              businessDate: night,
            }),
      ).catch(() => undefined);
      const balance = await inVenue((c) => prepaidBalance(c, venueId, account));
      expect(balance).toBe(await ledgerSum(account));
      expect(balance).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("merging sessions", () => {
  it("Room 10 into Room 9 keeps both deposits on one check, both sessions bill as before, and the totals add up", async () => {
    const now = SEED_NOW;
    const before = await inVenue(async (c) => [
      await checkView(c, venueId, ids["chk_room9"]!, now),
      await checkView(c, venueId, ids["chk_room10"]!, now),
    ]);
    const merged = await inVenue((c) =>
      mergeSessions(c, venueId, {
        intoSessionId: ids["sess_room9"]!,
        fromSessionId: ids["sess_room10"]!,
        by: ids["andy"]!,
        at,
      }),
    );
    expect(merged.checkId).toBe(ids["chk_room9"]);
    const deposits = await owner.query(
      `select a.amount_cents::int from payment_allocations a join payments p on p.id = a.payment_id
        where a.check_id = $1 and a.follows_lines and a.state = 'captured' and p.booking_id is not null order by 1`,
      [ids["chk_room9"]],
    );
    expect(deposits.rows.map((r) => r.amount_cents)).toEqual([9000, 12000]);
    const after = await inVenue((c) => checkView(c, venueId, ids["chk_room9"]!, now));
    expect(after.totals!.subtotal_cents).toBe(
      before[0]!.totals!.subtotal_cents + before[1]!.totals!.subtotal_cents,
    );
    // Each session keeps its own room and segments.
    const sessions = await owner.query(
      "select room_id, check_id from room_sessions where id = any($1::uuid[]) order by room_id",
      [[ids["sess_room9"], ids["sess_room10"]]],
    );
    expect(new Set(sessions.rows.map((r) => r.check_id))).toEqual(new Set([ids["chk_room9"]]));
    expect(sessions.rows.map((r) => r.room_id).sort()).toEqual(
      [ids["room_9"], ids["room_10"]].sort(),
    );
    // Room 10's check is empty now: its lines and its deposit moved.
    const left = await owner.query(
      "select coalesce(sum(amount_cents), 0)::int as s from check_lines where check_id = $1",
      [ids["chk_room10"]],
    );
    expect(left.rows[0].s).toBe(0);
  });

  it("a session whose check carries a card hold keeps the hold's allocation on the merged check", async () => {
    const hold = await inVenue(async (c) => {
      const p = await insertPayment(c, venueId, {
        method: "card_present",
        status: "authorized",
        businessDate: night,
      });
      await c.query(
        `insert into payment_allocations (venue_id, payment_id, check_id, amount_cents, kind, state, follows_lines)
         values ($1, $2, $3, 5000, 'payment', 'in_progress', true)`,
        [venueId, p, ids["chk_room7"]],
      );
      return p;
    });
    await inVenue((c) =>
      mergeSessions(c, venueId, {
        intoSessionId: ids["sess_room1"]!,
        fromSessionId: ids["sess_room7"]!,
        by: ids["andy"]!,
        at,
      }),
    );
    const moved = await owner.query(
      "select check_id, state, follows_lines, amount_cents::int from payment_allocations where payment_id = $1 order by created_at",
      [hold],
    );
    expect(moved.rows).toEqual([
      { check_id: ids["chk_room7"], state: "released", follows_lines: true, amount_cents: 5000 },
      { check_id: ids["chk_room1"], state: "in_progress", follows_lines: true, amount_cents: 5000 },
    ]);
  });
});
