import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  applyDeposits,
  generateSigningKey,
  insertPayment,
  loadDemoSeed,
  publishRulePack,
  withVenue,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, Temporal, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

let db: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
const clock = new FrozenClock(SEED_NOW);
const night = "2026-09-25";
const at = (hhmm: string) =>
  Temporal.ZonedDateTime.from(`2026-09-25T${hhmm}:00[America/New_York]`).toInstant();
const req = (method: "GET" | "POST", path: string, payload?: unknown) =>
  api.inject({ method, url: `/v1/venues/${venueId}${path}`, ...(payload ? { payload } : {}) });
const deposit = (bookingSlug: string, cents: number) =>
  withVenue(app, { venueId }, (c) =>
    insertPayment(c, venueId, {
      method: "card_online",
      status: "captured",
      businessDate: night,
      amountCents: cents,
      bookingId: ids[bookingSlug]!,
    }),
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
  const diego: Principal = {
    kind: "user",
    userId: ids["diego"]!,
    session: "passkey",
    memberships: [{ venueId, membershipId: ids["diego.membership"]!, role: "front_desk" }],
  };
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    moduleCacheMs: 0,
    authenticators: [async () => diego],
  });
  await api.ready();
});

afterAll(async () => {
  await api.close();
  await app.end();
  await owner.end();
  await db.drop();
});

describe("the deposit", () => {
  it("is applied when Sam O. checks in (3 guests, bills as 4): $40.00 off, and nothing shows below zero", async () => {
    await deposit("bk_sam", 4000);
    clock.set(at("22:44"));
    const preview = await req("GET", `/check-in/preview?booking=${ids["bk_sam"]}`);
    expect(preview.json().deposit_cents).toBe(4000);
    const r = await req("POST", `/bookings/${ids["bk_sam"]}/check-in`, {
      party_size: 3,
      ids_checked: 3,
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ billable_guests: 4, deposit_applied_cents: 4000 });
    const check = await req("GET", `/checks/${r.json().check_id}`);
    expect(check.json()).toMatchObject({ deposit_cents: 4000, amount_due_cents: 0 });
  });

  it("Room 9's presented check shows the $120.00 deposit paid and $498.60 left", async () => {
    clock.set(SEED_NOW);
    await deposit("bk_marcus", 12000);
    await withVenue(app, { venueId }, (c) =>
      applyDeposits(c, venueId, { bookingId: ids["bk_marcus"]!, checkId: ids["chk_room9"]! }),
    );
    await owner.query(
      "update orders set status = 'cancelled', cancel_reason = 'guest' where id = $1",
      [ids["order_o1"]],
    );
    expect((await req("POST", `/checks/${ids["chk_room9"]}/present`)).statusCode).toBe(200);
    const check = await req("GET", `/checks/${ids["chk_room9"]}`);
    expect(check.json()).toMatchObject({
      deposit_cents: 12000,
      amount_due_cents: 49860,
      totals: { total_cents: 61860 },
    });
  });

  it("a party that shrank to 8 on a $120.00 deposit closes at $103.10 with $0.00 left and a $16.90 forfeit on a fee check numbered next", async () => {
    clock.set(at("22:46"));
    await owner.query("update bookings set party_size = 12, deposit_cents = 12000 where id = $1", [
      ids["bk_parks"],
    ]);
    await deposit("bk_parks", 12000);
    const seated = await req("POST", `/bookings/${ids["bk_parks"]}/check-in`, {
      party_size: 8,
      ids_checked: 8,
      room_id: ids["room_11"],
    });
    expect(seated.statusCode, seated.body).toBe(201);
    const roomCheck = seated.json().check_id as string;
    expect((await req("GET", `/checks/${roomCheck}`)).json().amount_due_cents).toBe(0);
    const before = (await owner.query<{ n: string }>("select max(number) as n from checks"))
      .rows[0]!.n;
    const done = await req("POST", `/checks/${roomCheck}/finalize`);
    expect(done.json()).toMatchObject({ total_cents: 10310 });
    const fee = (
      await owner.query<{ id: string; number: string; status: string; kind: string }>(
        "select id, number, status, kind from checks where booking_id = $1 and kind = 'fee'",
        [ids["bk_parks"]],
      )
    ).rows[0]!;
    expect(Number(fee.number)).toBe(Number(before) + 1);
    expect(fee.status).toBe("paid");
    const forfeit = await owner.query(
      "select kind, amount_cents::int, tax_category from check_lines where check_id = $1",
      [fee.id],
    );
    expect(forfeit.rows).toEqual([{ kind: "forfeit", amount_cents: 1690, tax_category: "fee" }]);
    const room = (await req("GET", `/checks/${roomCheck}`)).json();
    expect(room).toMatchObject({ amount_due_cents: 0, deposit_cents: 10310 });
    // The deposit's money adds up: $103.10 on the room's check and $16.90 kept.
    const live = await owner.query<{ s: number }>(
      "select sum(a.amount_cents)::int as s from payment_allocations a join payments p on p.id = a.payment_id where p.booking_id = $1 and a.state = 'captured'",
      [ids["bk_parks"]],
    );
    expect(live.rows[0]!.s).toBe(12000);
    // Finalizing again changes nothing.
    await req("POST", `/checks/${roomCheck}/finalize`);
    const lines = await owner.query(
      "select count(*)::int as n from check_lines where check_id = $1",
      [fee.id],
    );
    expect(lines.rows[0].n).toBe(1);
  });
});
