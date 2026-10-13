import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { askRefund } from "./refunds.js";
import { computeReport } from "../nights/report.js";
import { buildNightJournal } from "../nights/journal.js";

/**
 * F-10 (D126): paid on the venue's own outside card machine. Refused while the switch is off; a
 * card number in the note is refused; a recorded payment pays the check down with its tip; Close
 * the night has its own total by person, posted to its own clearing account, never Stripe's; a
 * refund is recorded as succeeded with no Stripe call.
 */
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
const pay = (checkSlug: string, body: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/checks/${ids[checkSlug]}/payments`,
    headers: { "idempotency-key": `k-${Math.random()}` },
    payload: body,
  });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  pool = appPool(db.url);
  ids = Object.fromEntries(
    (
      await raw.query<{ slug: string; id: string }>(
        "select slug, row_id as id from seed_ids where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.slug, r.id]),
  );
  const maya: Principal = {
    kind: "user",
    userId: ids["maya"]!,
    session: "pin",
    memberships: [{ venueId, membershipId: ids["maya.membership"]!, role: "bartender" }],
  };
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [async () => maya],
    moduleCacheMs: 0,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await raw.end();
  await db.drop();
});

describe("paid on an outside card machine (F-10)", () => {
  let paymentId = "";

  it("is refused while the switch is off (the default)", async () => {
    const r = await pay("chk_t1", { method: "outside_card", amount_cents: 1000 });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.details).toMatchObject({ reason: "outside_card_off" });
  });

  it("refuses a card number in the note, and more than what's owed", async () => {
    await raw.query(
      "insert into venue_modules (venue_id, module_id, allowed, state) values ($1, 'outside_card', true, 'on')",
      [venueId],
    );
    const card = await pay("chk_t1", {
      method: "outside_card",
      amount_cents: 1000,
      note: "4242 4242 4242 4242",
    });
    expect(card.statusCode).toBe(400);
    expect(card.json().error.details).toMatchObject({ reason: "card_number" });
    const over = await pay("chk_t1", { method: "outside_card", amount_cents: 99_999_999 });
    expect(over.json().error.details).toMatchObject({ reason: "over" });
    expect((await raw.query("select 1 from payments where method = 'outside_card'")).rowCount).toBe(
      0,
    );
  });

  it("records the amount and tip, pays the check down, and keeps only the note", async () => {
    const r = await pay("chk_room9", {
      method: "outside_card",
      amount_cents: 3800,
      tip_cents: 760,
      note: "Auth 0X12AB",
    });
    expect(r.statusCode, r.body).toBe(201);
    // What the check still owed (its deposit already applied): it's paid now.
    expect(r.json().check_status).toBe("paid");
    const row = (
      await raw.query<{
        status: string;
        amount_cents: string;
        tip_cents: string;
        taken_by: string;
        outside_note: string;
        stripe_pi_id: string | null;
      }>(
        "select status, amount_cents, tip_cents, taken_by, outside_note, stripe_pi_id from payments where method = 'outside_card'",
      )
    ).rows[0]!;
    paymentId = (
      await raw.query<{ id: string }>("select id from payments where method = 'outside_card'")
    ).rows[0]!.id;
    expect(row).toMatchObject({
      status: "captured",
      amount_cents: "3800",
      tip_cents: "760",
      taken_by: ids["maya"],
      outside_note: "Auth 0X12AB",
      stripe_pi_id: null,
    });
  });

  it("Close the night shows it by person, and the journal posts it to its own clearing account", async () => {
    const report = await withVenue(pool, { venueId }, (c) =>
      computeReport(c, venueId, "2026-09-25", clock.now(), "x"),
    );
    expect(report.payments).toMatchObject({
      outside_card_cents: 3800,
      outside_card_tips_cents: 760,
      outside_card_total_cents: 4560,
      outside_card_by_person: [{ name: expect.stringMatching(/^Maya/), cents: 4560 }],
    });
    const journal = await withVenue(pool, { venueId }, (c) =>
      buildNightJournal(c, venueId, "2026-09-25", report),
    );
    const clearing = journal.lines.filter((l) => l.account === "outside_card_clearing");
    expect(clearing.reduce((s, l) => s + l.debit_cents - l.credit_cents, 0)).toBe(4560);
    const debits = journal.lines.reduce((s, l) => s + l.debit_cents, 0);
    const credits = journal.lines.reduce((s, l) => s + l.credit_cents, 0);
    expect(debits).toBe(credits);
  });

  it("a refund is recorded as refunded on the outside machine, with no Stripe call", async () => {
    await raw.query(
      `insert into venue_settings (venue_id, key, version, value, starts_on) values ($1, 'approvals', 50, '{"mode":"none"}', '2026-09-25')`,
      [venueId],
    );
    const asked = await withVenue(pool, { venueId }, (c) =>
      askRefund(c, venueId, {
        checkId: ids["chk_room9"]!,
        bookingId: null,
        lines: [],
        parts: [{ paymentId, amountCents: 1000 }],
        reason: "Wrong drink",
        userId: ids["andy"]!,
        deviceId: null,
        businessDate: "2026-09-25",
        now: clock.now(),
      }),
    );
    expect(asked.status).toBe("approved");
    const refund = (
      await raw.query<{ status: string; stripe_refund_id: string | null }>(
        "select status, stripe_refund_id from refunds where payment_id = $1",
        [paymentId],
      )
    ).rows[0]!;
    expect(refund).toEqual({ status: "succeeded", stripe_refund_id: null });
    expect((await raw.query("select 1 from jobs where kind = 'refund.run'")).rowCount).toBe(0);
  });
});
