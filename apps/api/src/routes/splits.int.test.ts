import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { StripeClient } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { fakeStripeSettings } from "../stripe/settings.js";

let db: TestDatabase;
let owner: pg.Pool;
let api: FastifyInstance;
let fake: FakeStripe;
let stripe: StripeClient;
let venueId: string;
let ids: Record<string, string>;
let account: string;
const clock = new FrozenClock(SEED_NOW);
let n = 0;
const post = (path: string, payload?: unknown) =>
  api.inject({
    method: "POST",
    url: `/v1/venues/${venueId}${path}`,
    headers: { "idempotency-key": `split-${++n}` },
    ...(payload ? { payload } : {}),
  });
const check = async (slug: string) =>
  (await api.inject({ method: "GET", url: `/v1/venues/${venueId}/checks/${ids[slug]}` })).json();
const present = async (slug: string, orders: string[] = []) => {
  for (const o of orders)
    await owner.query(
      "update orders set status = 'cancelled', cancel_reason = 'guest' where id = $1",
      [ids[o]],
    );
  const r = await post(`/checks/${ids[slug]}/present`);
  expect(r.statusCode, r.body).toBe(200);
};
const presentCard = async (readerSlug: string) => {
  const reader = (
    await owner.query<{ s: string }>("select stripe_reader_id as s from devices where id = $1", [
      ids[readerSlug],
    ])
  ).rows[0]!.s;
  const r = await fetch(
    `${fake.base}/v1/test_helpers/terminal/readers/${reader}/present_payment_method`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer rk_test_fake_payments",
        "stripe-account": account,
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": `split-present-${++n}`,
      },
      body: "",
    },
  );
  expect(r.status).toBe(200);
};
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

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
  fake = new FakeStripe();
  stripe = new StripeClient(fakeStripeSettings(await fake.start()));
  account = (
    await stripe.call<{ id: string }>("payments", "POST", "/v2/core/accounts", {
      account: null,
      platform: true,
      idempotencyKey: "split-acct",
      params: { display_name: "West 4 Boho Karaoke" },
    })
  ).id;
  await owner.query("update organizations set stripe_account_id = $1", [account]);
  const andy: Principal = {
    kind: "user",
    userId: ids["andy"]!,
    session: "passkey",
    memberships: [{ venueId, membershipId: ids["andy.membership"]!, role: "owner" }],
  };
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    stripe,
    moduleCacheMs: 0,
    authenticators: [async () => andy],
  });
  await api.ready();
  for (const label of ["Bar S710", "Front desk S710"])
    await api.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/readers`,
      payload: { registration_code: "simulated-s710", label },
    });
});

beforeEach(async () => {
  await owner.query(
    "update device_heartbeats set last_seen_at = $1, offline_since = null where device_id in (select id from devices where kind = 'reader')",
    [new Date(clock.now().epochMilliseconds)],
  );
});

afterAll(async () => {
  await api.close();
  await fake.stop();
  await owner.end();
  await db.drop();
});

describe("splits", () => {
  it("Room 9's $498.60 in three: $166.20 each; share 1 by tap and share 2 in cash stay paid when the tab is opened again", async () => {
    await present("chk_room9", ["order_o1"]);
    const made = await post(`/checks/${ids["chk_room9"]}/splits`, { kind: "even", shares: 3 });
    expect(made.statusCode, made.body).toBe(201);
    const split = made.json().split;
    expect(split.shares.map((s: { amount_cents: number }) => s.amount_cents)).toEqual([
      16620, 16620, 16620,
    ]);
    // Every split adds up to the cent: the shares, their tax parts and their gratuity parts.
    expect(sum(split.shares.map((s: { amount_cents: number }) => s.amount_cents))).toBe(49860);
    expect(sum(split.shares.map((s: { tax_cents: number }) => s.tax_cents))).toBe(4260);
    expect(sum(split.shares.map((s: { gratuity_cents: number }) => s.gratuity_cents))).toBe(9600);

    const [one, two] = split.shares;
    const tap = await post(`/checks/${ids["chk_room9"]}/payments`, {
      method: "tap",
      amount_cents: one.amount_cents,
      reader_id: ids["dev_front_reader"],
      share_id: one.id,
    });
    expect(tap.json().state).toBe("waiting");
    await presentCard("dev_front_reader");
    expect((await post(`/payments/${tap.json().id}/check-status`)).json().state).toBe("paid");
    const cash = await post(`/checks/${ids["chk_room9"]}/payments`, {
      method: "cash",
      amount_cents: two.amount_cents,
      tendered_cents: 17000,
      share_id: two.id,
    });
    expect(cash.statusCode, cash.body).toBe(201);

    const again = await check("chk_room9");
    expect(again.check.status).toBe("partly_paid");
    expect(again.amount_due_cents).toBe(16620);
    expect(again.split.shares.map((s: { state: string }) => s.state)).toEqual([
      "paid",
      "paid",
      "open",
    ]);
    // The same share can't be paid twice.
    const twice = await post(`/checks/${ids["chk_room9"]}/payments`, {
      method: "cash",
      amount_cents: two.amount_cents,
      tendered_cents: 17000,
      share_id: two.id,
    });
    expect(twice.statusCode).toBe(409);
  });

  it("pays two shares at once on the two readers, and won't start the same share twice", async () => {
    await present("chk_room1");
    const split = (
      await post(`/checks/${ids["chk_room1"]}/splits`, { kind: "even", shares: 2 })
    ).json().split;
    const [a, b] = split.shares;
    const [ta, tb] = await Promise.all([
      post(`/checks/${ids["chk_room1"]}/payments`, {
        method: "tap",
        amount_cents: a.amount_cents,
        reader_id: ids["dev_bar_reader"],
        share_id: a.id,
      }),
      post(`/checks/${ids["chk_room1"]}/payments`, {
        method: "tap",
        amount_cents: b.amount_cents,
        reader_id: ids["dev_front_reader"],
        share_id: b.id,
      }),
    ]);
    expect([ta.json().state, tb.json().state]).toEqual(["waiting", "waiting"]);
    const dup = await post(`/checks/${ids["chk_room1"]}/payments`, {
      method: "cash",
      amount_cents: a.amount_cents,
      tendered_cents: a.amount_cents,
      share_id: a.id,
    });
    expect(dup.statusCode).toBe(409);
    await presentCard("dev_bar_reader");
    await presentCard("dev_front_reader");
    for (const t of [ta, tb])
      expect((await post(`/payments/${t.json().id}/check-status`)).json().state).toBe("paid");
    expect((await check("chk_room1")).check.status).toBe("paid");
  });

  it("Stop splitting after one paid share charges the rest as one payment and keeps share 1 paid", async () => {
    await present("chk_room3");
    const split = (
      await post(`/checks/${ids["chk_room3"]}/splits`, { kind: "even", shares: 3 })
    ).json().split;
    const first = split.shares[0];
    await post(`/checks/${ids["chk_room3"]}/payments`, {
      method: "cash",
      amount_cents: first.amount_cents,
      tendered_cents: first.amount_cents,
      share_id: first.id,
    });
    expect((await post(`/splits/${split.id}/stop`)).json()).toMatchObject({ stopped: true });
    const after = await check("chk_room3");
    expect(after.split).toBeNull();
    const rest = after.amount_due_cents;
    expect(rest).toBe(split.base_cents - first.amount_cents);
    const paid = await post(`/checks/${ids["chk_room3"]}/payments`, {
      method: "cash",
      amount_cents: rest,
      tendered_cents: rest,
    });
    expect(paid.json()).toMatchObject({ check_status: "paid" });
    const kept = await owner.query("select state from split_shares where id = $1", [first.id]);
    expect(kept.rows[0].state).toBe("paid");
  });

  it("splits by item: each person's own items and an even part of room time, tax and gratuity by largest remainder", async () => {
    await present("chk_room7");
    const lines = (await check("chk_room7")).lines as {
      id: number;
      kind: string;
      description: string;
      amount_cents: number;
    }[];
    const items = lines.filter((l) => l.kind === "item");
    const claims = Object.fromEntries(items.map((l, i) => [String(l.id), i % 2]));
    const r = await post(`/checks/${ids["chk_room7"]}/splits`, {
      kind: "items",
      people: 2,
      claims,
    });
    expect(r.statusCode, r.body).toBe(201);
    const split = r.json().split;
    const rev = (await check("chk_room7")).totals;
    expect(sum(split.shares.map((s: { amount_cents: number }) => s.amount_cents))).toBe(
      split.base_cents,
    );
    expect(sum(split.shares.map((s: { tax_cents: number }) => s.tax_cents))).toBe(rev.tax_cents);
    expect(sum(split.shares.map((s: { gratuity_cents: number }) => s.gratuity_cents))).toBe(
      rev.gratuity_cents,
    );
    // Each person's own items are on their share.
    expect(split.shares[0].line_ids).toEqual(items.filter((_, i) => i % 2 === 0).map((l) => l.id));
    expect(split.shares[1].line_ids).toEqual(items.filter((_, i) => i % 2 === 1).map((l) => l.id));
  });
});
