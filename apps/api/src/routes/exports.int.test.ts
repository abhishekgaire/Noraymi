import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { isBalanced, type Journal } from "@west4/rules";
import { FrozenClock, SEED_NOW, Temporal, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { sweepClearOut } from "../rooms/clear-out.js";

/**
 * The nightly accounting journal and Export for QuickBooks (M7-15): posted at the close, balanced,
 * kept with the close (`night_closes.export_id`), Room 9's deposit and a $5.00 short drawer where
 * they belong, practice money left out; the export refused from a PIN session, downloaded and emailed
 * with the passkey asked again.
 */
let db: TestDatabase;
let owner: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
const clock = new FrozenClock(SEED_NOW);
const FRI = "2026-09-25";

/** A signed-in session for a seeded person, and a fresh step-up token for it (as a passkey gives). */
async function as(
  who: string,
  method: "GET" | "POST" | "PUT",
  path: string,
  payload?: object,
  opts: { assurance?: "passkey" | "pin"; stepUp?: boolean } = {},
) {
  const token = randomBytes(24).toString("base64url");
  const step = randomBytes(24).toString("base64url");
  const session = (
    await owner.query<{ id: string }>(
      `insert into auth_sessions (principal, user_id, membership_id, assurance, client, token_hash, started_at, last_seen_at, expires_at)
       values ('staff', $1, $2, $3, 'web', $4, now(), now(), now() + interval '1 hour') returning id`,
      [
        ids[who],
        ids[`${who}.membership`],
        opts.assurance ?? "passkey",
        createHash("sha256").update(token).digest("hex"),
      ],
    )
  ).rows[0]!.id;
  await owner.query(
    `insert into auth_challenges (user_id, purpose, challenge, session_id, attempts, created_at, expires_at)
     values ($1, 'step_up_token', $2, $3, 0, now(), now() + interval '1 hour')`,
    [ids[who], createHash("sha256").update(step).digest("hex"), session],
  );
  return api.inject({
    method,
    url: `/v1/venues/${venueId}${path}`,
    headers: {
      authorization: `Bearer ${token}`,
      ...(opts.stepUp === false ? {} : { "x-step-up": step }),
      "idempotency-key": randomUUID(),
    },
    ...(payload ? { payload } : {}),
  });
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
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
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    moduleCacheMs: 0,
  });
  await api.ready();
});

afterAll(async () => {
  await api.close();
  await owner.end();
  await db.drop();
});

describe("the nightly journal and Export for QuickBooks", () => {
  it("posts a balanced journal at the close, with Room 9's deposit, a $5.00 short drawer, and no practice money", async () => {
    // A $5.00 short front-desk drawer, and a practice cash payment that must not reach the books.
    await owner.query(
      `update drawer_sessions set state = 'counted', counted_cents = opening_cents - case when drawer_id =
         (select id from cash_drawers where name = 'Front-desk drawer') then 500 else 0 end,
         expected_cents = opening_cents,
         over_short_cents = case when drawer_id = (select id from cash_drawers where name = 'Front-desk drawer') then -500 else 0 end
       where venue_id = $1 and state = 'open'`,
      [venueId],
    );
    await owner.query(
      `insert into payments (venue_id, method, status, amount_cents, tip_cents, business_date, training)
       values ($1, 'cash', 'captured', 77700, 0, $2, true)`,
      [venueId, FRI],
    );
    // Everything else that blocks the close, dealt with.
    clock.set(Temporal.Instant.from("2026-09-26T04:48:00-04:00"));
    for (const sql of [
      "update room_sessions set ended_at = now() where venue_id = $1 and ended_at is null",
      "update tabs set state = 'captured' where venue_id = $1 and state in ('open', 'tipping')",
      "update waitlist_entries set status = 'left' where venue_id = $1 and status in ('waiting', 'offered')",
      "update orders set status = 'cancelled', cancel_reason = 'staff' where venue_id = $1 and status in ('ringing', 'held')",
      "update approvals set status = 'declined' where venue_id = $1 and status = 'pending'",
      "update room_states set state = 'available' where venue_id = $1 and state = 'cleaning'",
      "update order_drafts set lines = '[]' where venue_id = $1",
    ])
      await owner.query(sql, [venueId]);
    await owner.query(
      `update shifts set ended_at = now() where venue_id = $1 and ended_at is null
         and membership_id <> $2`,
      [venueId, ids["andy.membership"]],
    );
    await sweepClearOut(owner, Temporal.Instant.from("2026-09-26T04:31:00-04:00"));
    expect((await as("andy", "POST", `/nights/${FRI}/clear-out`, {})).statusCode).toBe(200);
    const closed = await as("andy", "POST", `/nights/${FRI}/close`, {});
    expect(closed.statusCode, closed.body).toBe(200);

    const row = await owner.query<{ id: string; journals: Journal[]; file: string }>(
      "select e.id, e.journals, e.file from exports e join night_closes n on n.export_id = e.id where n.business_date = $1",
      [FRI],
    );
    expect(row.rows).toHaveLength(1);
    const night = row.rows[0]!.journals.find((j) => j.kind === "night")!;
    expect(isBalanced(night)).toBe(true);
    const at = (account: string) =>
      night.lines
        .filter((l) => l.account === account)
        .reduce((s, l) => s + l.debit_cents - l.credit_cents, 0);
    expect(at("cash_over_short")).toBe(500);
    // Customer deposits: what was allocated to Friday's checks (Room 9's $120.00 among them) comes off,
    // what was taken Friday for later bookings is still held.
    const dep = (
      await owner.query<{ allocated: string; taken: string; room9: string }>(
        `select
           (select coalesce(sum(a.amount_cents), 0) from payment_allocations a join payments p on p.id = a.payment_id
              join checks k on k.id = a.check_id
             where p.booking_id is not null and not p.training and k.business_date = $1 and a.state = 'captured')::text as allocated,
           (select coalesce(sum(amount_cents), 0) from payments
             where booking_id is not null and not training and business_date = $1
               and status in ('captured', 'partly_refunded', 'refunded'))::text as taken,
           (select coalesce(sum(a.amount_cents), 0) from payment_allocations a join payments p on p.id = a.payment_id
             where p.booking_id is not null and a.check_id = $2)::text as room9`,
        [FRI, ids["chk_room9"]],
      )
    ).rows[0]!;
    expect(Number(dep.room9)).toBe(12000);
    expect(at("customer_deposits")).toBe(Number(dep.allocated) - Number(dep.taken));
    expect(row.rows[0]!.file).not.toContain("777.00");
  });

  it("refuses the export from a PIN session or without the passkey again; downloads and emails with it", async () => {
    expect(
      (await as("andy", "GET", `/exports/accounting?date=${FRI}`, undefined, { assurance: "pin" }))
        .statusCode,
    ).toBe(403);
    expect(
      (await as("andy", "GET", `/exports/accounting?date=${FRI}`, undefined, { stepUp: false }))
        .statusCode,
    ).toBe(403);
    const r = await as("abhishek", "GET", `/exports/accounting?date=${FRI}`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().file.split("\n")[0]).toBe(
      "Journal No,Journal Date,Account,Debits,Credits,Description,Memo",
    );
    expect(r.json().file).toContain("Cash over and short,5.00");
    // Where the file goes, set by the owner; then the email.
    expect(
      (await as("abhishek", "POST", `/exports/${r.json().export_id}/email`, {})).json().error
        .details.reason,
    ).toBe("no_address");
    const pay = (await as("abhishek", "GET", "/settings/pay")).json() as {
      value: Record<string, unknown>;
    };
    const saved = await as("abhishek", "PUT", "/settings/pay", {
      value: {
        ...pay.value,
        accounting: {
          emailTo: ["books@demo.west4.local"],
          accounts: { cash: "Undeposited Funds" },
        },
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const sent = await as("abhishek", "POST", `/exports/${r.json().export_id}/email`, {});
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json().emailed_to).toEqual(["books@demo.west4.local"]);
    const job = await owner.query<{ to: string }>(
      "select payload ->> 'to' as to from jobs where kind = 'email.send' and payload ->> 'template' = 'accounting_export'",
    );
    expect(job.rows).toEqual([{ to: "books@demo.west4.local" }]);
    // The owner's account names are used in the file from now on.
    expect((await as("abhishek", "GET", `/exports/accounting?date=${FRI}`)).json().file).toContain(
      "Undeposited Funds",
    );
  });
});
