import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addCheckLine, insertCheck } from "./checks.js";
import {
  AttemptOpen,
  OverAmountDue,
  allocate,
  amountDue,
  insertPayment,
  recordCapture,
  setPaymentStatus,
  startAttempt,
} from "./payments.js";
import { loadDemoSeed, seedId } from "./seed.js";
import { withVenue } from "./tenancy.js";
import { appPool, createTestDatabase, type TestDatabase } from "./test-helpers.js";

let db: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let venueId: string;
let otherVenue: string;
let room9: string;
let diego: string;
const night = "2026-09-25";

const inVenue = <T>(work: (c: pg.PoolClient) => Promise<T>, venue = venueId) =>
  withVenue(app, { venueId: venue }, work as never) as Promise<T>;

/** A new bar check with the given lines, inside the venue. */
async function barCheck(lines: number[]): Promise<string> {
  return inVenue(async (c) => {
    const n = await c.query<{ n: number }>(
      "select coalesce(max(number), 5000) + 1 as n from checks",
    );
    const id = await insertCheck(c, {
      venueId,
      number: n.rows[0]!.n,
      kind: "bar",
      businessDate: night,
      openedBy: diego,
    });
    for (const cents of lines)
      await addCheckLine(c, venueId, id, {
        kind: "item",
        description: "Drink",
        qty: 1,
        unitCents: cents,
        amountCents: cents,
        taxCategory: "drink",
        businessDate: night,
      });
    return id;
  });
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  app = appPool(db.url);
  room9 = await seedId(owner, venueId, "chk_room9");
  diego = await seedId(owner, venueId, "diego");
  const org = (
    await owner.query<{ id: string }>(
      "insert into organizations (legal_name) values ('Other') returning id",
    )
  ).rows[0]!.id;
  otherVenue = (
    await owner.query<{ id: string }>(
      "insert into venues (org_id, name, slug) values ($1, 'Other', 'other-p') returning id",
      [org],
    )
  ).rows[0]!.id;
});

afterAll(async () => {
  await app.end();
  await owner.end();
  await db.drop();
});

describe("the payment tables", () => {
  it("the app role can't update a payment's amount, or delete any payment, attempt, allocation or event", async () => {
    const pay = await inVenue((c) =>
      insertPayment(c, venueId, {
        method: "cash",
        status: "captured",
        businessDate: night,
        amountCents: 1000,
      }),
    );
    const tries = [
      "update payments set amount_cents = 1 where id = $1",
      "update payments set tip_cents = 1 where id = $1",
      "delete from payments where id = $1",
      "delete from payment_attempts where payment_id = $1",
      "delete from payment_allocations where payment_id = $1",
      "delete from payment_events where payment_id = $1",
    ];
    for (const sql of tries)
      await expect(
        inVenue((c) => c.query(sql, [pay])),
        sql,
      ).rejects.toThrow(/permission denied/);
  });

  it("only the definer functions move an amount, never a cash payment's, and each change is audited", async () => {
    const cash = await inVenue((c) =>
      insertPayment(c, venueId, {
        method: "cash",
        status: "captured",
        businessDate: night,
        amountCents: 1000,
      }),
    );
    await expect(
      inVenue((c) => recordCapture(c, cash, { amountCents: 2000, tipCents: 0, surchargeCents: 0 })),
    ).rejects.toThrow(/no card payment/);
    const card = await inVenue((c) =>
      insertPayment(c, venueId, {
        method: "card_present",
        status: "authorized",
        businessDate: night,
      }),
    );
    await inVenue((c) =>
      recordCapture(c, card, { amountCents: 4800, tipCents: 700, surchargeCents: 0 }),
    );
    const audit = await owner.query<{
      old_values: Record<string, unknown>;
      new_values: Record<string, unknown>;
    }>(
      "select old_values, new_values from audit_log where target = $1 and action = 'payments.update'",
      [`payments/${card}`],
    );
    expect(audit.rows[0]).toMatchObject({
      old_values: { amount_cents: 0, tip_cents: 0 },
      new_values: { amount_cents: 4800, tip_cents: 700 },
    });
    // Another venue can't reach it, even through the definer function.
    await expect(
      inVenue(
        (c) => recordCapture(c, card, { amountCents: 1, tipCents: 0, surchargeCents: 0 }),
        otherVenue,
      ),
    ).rejects.toThrow(/no card payment/);
  });

  it("refuses a second unfinished attempt for the same check and portion (one_open_attempt)", async () => {
    const check = await barCheck([1300]);
    const attempt = async () =>
      inVenue(async (c) => {
        const p = await insertPayment(c, venueId, {
          method: "card_present",
          status: "pending",
          businessDate: night,
        });
        return startAttempt(c, venueId, {
          paymentId: p,
          checkId: check,
          portionKey: "full",
          action: "process",
          amountCents: 1300,
        });
      });
    expect((await attempt()).idemKey).toMatch(/:process:1$/);
    await expect(attempt()).rejects.toBeInstanceOf(AttemptOpen);
  });

  it("Room 9: $618.60 of lines with the $120.00 deposit allocated leaves $498.60 due, and $498.61 is refused", async () => {
    await inVenue(async (c) => {
      for (const [kind, cents, cat] of [
        ["room_time", 32200, "room_time"],
        ["tax", 4260, null],
        ["gratuity", 9600, null],
      ] as const)
        await addCheckLine(c, venueId, room9, {
          kind,
          description: kind,
          qty: 1,
          unitCents: cents,
          amountCents: cents,
          taxCategory: cat,
          businessDate: night,
        });
      // Marcus's $120.00 deposit is the seed's, allocated at check-in (M4-10).
    });
    expect(await inVenue((c) => amountDue(c, room9))).toBe(49860);
    const tooMuch = inVenue(async (c) => {
      const p = await insertPayment(c, venueId, {
        method: "cash",
        status: "captured",
        businessDate: night,
        amountCents: 49861,
      });
      return allocate(c, venueId, {
        paymentId: p,
        checkId: room9,
        amountCents: 49861,
        state: "captured",
      });
    });
    await expect(tooMuch).rejects.toMatchObject({ name: "OverAmountDue", dueCents: 49860 });
  });

  it("a $50.00 hold on an empty tab shows $0.00 due, never −$50.00, and the tab's balance leaves its own hold out", async () => {
    const tab = await barCheck([]);
    const hold = await inVenue(async (c) => {
      const p = await insertPayment(c, venueId, {
        method: "card_present",
        status: "authorized",
        businessDate: night,
      });
      await allocate(c, venueId, {
        paymentId: p,
        checkId: tab,
        amountCents: 5000,
        state: "in_progress",
        followsLines: true,
      });
      return p;
    });
    expect(await inVenue((c) => amountDue(c, tab))).toBe(0);
    await inVenue((c) =>
      addCheckLine(c, venueId, tab, {
        kind: "item",
        description: "Beer",
        qty: 1,
        unitCents: 900,
        amountCents: 900,
        taxCategory: "drink",
        businessDate: night,
      }),
    );
    expect(await inVenue((c) => amountDue(c, tab))).toBe(0);
    expect(await inVenue((c) => amountDue(c, tab, hold))).toBe(900);
  });

  it("two payments racing for more than the amount due between them: one lands, the other is refused", async () => {
    const check = await barCheck([5000]);
    const pay = () =>
      inVenue(async (c) => {
        const p = await insertPayment(c, venueId, {
          method: "cash",
          status: "captured",
          businessDate: night,
          amountCents: 3000,
        });
        const id = await allocate(c, venueId, {
          paymentId: p,
          checkId: check,
          amountCents: 3000,
          state: "captured",
        });
        await new Promise((r) => setTimeout(r, 50)); // hold the check's lock a moment
        return id;
      });
    const results = await Promise.allSettled([pay(), pay()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(OverAmountDue);
    expect(await inVenue((c) => amountDue(c, check))).toBe(2000);
  });

  it("never shows a negative amount due, and allocations add up, over random checks (property)", async () => {
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let i = 0; i < 25; i++) {
      const lines = Array.from({ length: rand(4) }, () => 100 + rand(5000));
      const total = lines.reduce((a, b) => a + b, 0);
      const check = await barCheck(lines);
      let paid = 0;
      await inVenue(async (c) => {
        if (rand(2)) {
          const hold = await insertPayment(c, venueId, {
            method: "card_present",
            status: "authorized",
            businessDate: night,
          });
          await allocate(c, venueId, {
            paymentId: hold,
            checkId: check,
            amountCents: 100 + rand(8000),
            state: "in_progress",
            followsLines: true,
          });
        }
        for (let k = 0; k < 3; k++) {
          const ask = 1 + rand(4000);
          const p = await insertPayment(c, venueId, {
            method: "cash",
            status: "captured",
            businessDate: night,
            amountCents: ask,
          });
          try {
            await allocate(c, venueId, {
              paymentId: p,
              checkId: check,
              amountCents: ask,
              state: "captured",
            });
            paid += ask;
          } catch (e) {
            expect(e).toBeInstanceOf(OverAmountDue);
          }
          const due = await amountDue(c, check);
          expect(due).toBeGreaterThanOrEqual(0);
          // Without a hold the payments and what's due add up to the lines.
          const holds = await c.query(
            "select 1 from payment_allocations where check_id = $1 and follows_lines",
            [check],
          );
          if (holds.rowCount === 0) expect(due + paid).toBe(total);
          else expect(due + paid).toBeLessThanOrEqual(total);
        }
      });
    }
  });

  it("records every status change with where it came from", async () => {
    const p = await inVenue((c) =>
      insertPayment(c, venueId, { method: "card_present", status: "pending", businessDate: night }),
    );
    await inVenue((c) => setPaymentStatus(c, venueId, p, "authorized", "webhook", "evt_1"));
    await inVenue((c) => setPaymentStatus(c, venueId, p, "captured", "reconciler"));
    const events = await owner.query(
      "select from_status, to_status, source, stripe_event_id from payment_events where payment_id = $1 order by id",
      [p],
    );
    expect(events.rows).toEqual([
      { from_status: null, to_status: "pending", source: "api", stripe_event_id: null },
      {
        from_status: "pending",
        to_status: "authorized",
        source: "webhook",
        stripe_event_id: "evt_1",
      },
      {
        from_status: "authorized",
        to_status: "captured",
        source: "reconciler",
        stripe_event_id: null,
      },
    ]);
  });
});
