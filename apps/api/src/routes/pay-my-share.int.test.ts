import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  generateSigningKey,
  loadDemoSeed,
  publishRulePack,
  seedHostToken,
  withVenue,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { presentCheck } from "../rooms/present.js";
import { StripeClient } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { fakeStripeSettings } from "../stripe/settings.js";

/** Pay my share (M4-18) on Room 9, against the fake Stripe, each case on a fresh load of the seed. */
interface World {
  db: TestDatabase;
  owner: pg.Pool;
  app: pg.Pool;
  api: FastifyInstance;
  fake: FakeStripe;
  venueId: string;
  ids: Record<string, string>;
  as: { who: Principal | undefined };
}
const clock = new FrozenClock(SEED_NOW);
const cookieOf = (h: string | string[] | undefined) =>
  String(Array.isArray(h) ? h[0] : h).split(";")[0]!;

async function world(o1: "cancelled" | "accepted"): Promise<World> {
  const db = await createTestDatabase({ migrate: true });
  const venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } }))
    .venueId;
  const owner = new pg.Pool({ connectionString: db.url });
  const app = appPool(db.url);
  const key = generateSigningKey().privateKeyPem;
  for (const pack of [newYorkCounty, newYorkCountyTaxed])
    await publishRulePack(owner, {
      pack,
      effectiveOn: "2026-09-01",
      approvedBy: ["A", "B"],
      privateKeyPem: key,
    });
  const ids = Object.fromEntries(
    (
      await owner.query<{ slug: string; id: string }>("select slug, row_id as id from seed_ids")
    ).rows.map((r) => [r.slug, r.id]),
  );
  const fake = new FakeStripe();
  const stripe = new StripeClient(fakeStripeSettings(await fake.start()));
  const account = (
    await stripe.call<{ id: string }>("payments", "POST", "/v2/core/accounts", {
      account: null,
      platform: true,
      idempotencyKey: "share-acct",
      params: { display_name: "West 4 Boho Karaoke" },
    })
  ).id;
  await owner.query("update organizations set stripe_account_id = $1", [account]);
  const as: World["as"] = { who: undefined };
  const api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    stripe,
    moduleCacheMs: 0,
    authenticators: [async () => as.who],
  });
  await api.ready();
  const w = { db, owner, app, api, fake, venueId, ids, as };
  if (o1 === "cancelled")
    await owner.query(
      "update orders set status = 'cancelled', cancel_reason = 'guest' where id = $1",
      [ids["order_o1"]],
    );
  else {
    const r = await staff(w, "POST", `/orders/${ids["order_o1"]}/accept`, {});
    expect(r.statusCode, r.body).toBe(200);
  }
  await withVenue(app, { venueId }, (c) =>
    presentCheck(c, venueId, ids["chk_room9"]!, { userId: ids["andy"]!, now: clock.now() }),
  );
  return w;
}

async function drop(w: World) {
  await w.api.close();
  await w.fake.stop();
  await w.app.end();
  await w.owner.end();
  await w.db.drop();
}

function staff(w: World, method: "GET" | "POST", path: string, payload?: object) {
  w.as.who = {
    kind: "user",
    userId: w.ids["andy"]!,
    session: "passkey",
    memberships: [
      { venueId: w.venueId, membershipId: w.ids["andy.membership"]!, role: "manager" } as never,
    ],
  };
  return w.api
    .inject({
      method,
      url: `/v1/venues/${w.venueId}${path}`,
      headers: { "idempotency-key": randomUUID() },
      ...(payload ? { payload } : {}),
    })
    .finally(() => {
      w.as.who = undefined;
    });
}

/** The host and eleven friends on Room 9's page. */
async function guests(w: World): Promise<string[]> {
  const host = cookieOf(
    (
      await w.api.inject({
        method: "POST",
        url: "/v1/public/room-session/host",
        payload: { token: seedHostToken("sess_room9") },
      })
    ).headers["set-cookie"],
  );
  const friends: string[] = [];
  for (let i = 0; i < 11; i++)
    friends.push(
      cookieOf(
        (
          await w.api.inject({
            method: "POST",
            url: `/v1/public/venues/west4karaoke/rooms/${w.ids["room_9"]}/join`,
            payload: { code: "KX4M7" },
          })
        ).headers["set-cookie"],
      ),
    );
  return [host, ...friends];
}
const guest = (w: World, cookie: string, method: "GET" | "POST", path: string, payload?: object) =>
  w.api.inject({
    method,
    url: `/v1/public/room-session${path}`,
    headers: { cookie },
    ...(payload ? { payload } : {}),
  });
const pay = async (w: World, url: string) => {
  const token = url.split("/pay/")[1]!;
  expect((await w.api.inject({ method: "POST", url: `/v1/public/pay/${token}` })).statusCode).toBe(
    200,
  );
  const done = await w.api.inject({
    method: "POST",
    url: `/v1/public/pay/${token}/confirm`,
    payload: { test_card: "pm_card_visa" },
  });
  expect(done.json().status, done.body).toBe("paid");
};

describe("twelve guests, one share each", () => {
  let w: World;
  let phones: string[];
  beforeAll(async () => {
    w = await world("cancelled");
    phones = await guests(w);
  });
  afterAll(() => drop(w));

  it("with pay.payShare off, the bill offers no share and the route refuses", async () => {
    await w.owner.query(
      "update venue_settings set value = jsonb_set(value, '{payShare,on}', 'false') where key = 'pay'",
    );
    expect((await guest(w, phones[1]!, "GET", "/bill")).json().presented.pay_share).toBeNull();
    const r = await guest(w, phones[1]!, "POST", "/shares", { kind: "even" });
    expect(r.statusCode).toBe(403);
    await w.owner.query(
      "update venue_settings set value = jsonb_set(value, '{payShare,on}', 'true') where key = 'pay'",
    );
    expect((await guest(w, phones[1]!, "GET", "/bill")).json().presented.pay_share).toEqual({
      shares: 12,
    });
  });

  it("Kevin's share is 1 of 12: $41.55 with $3.55 of tax and $8.00 of gratuity, and it shows on the room tab", async () => {
    const r = await guest(w, phones[1]!, "POST", "/shares", { kind: "even", name: "Kevin" });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().share).toMatchObject({
      share_no: 1,
      shares: 12,
      share_cents: 4155,
      tax_cents: 355,
      gratuity_cents: 800,
      amount_cents: 4155,
    });
    // Asking again gives the same share and the same payment.
    const again = (await guest(w, phones[1]!, "POST", "/shares", { kind: "even" })).json();
    expect(again.share).toMatchObject({ share_no: 1, state: "paying" });
    await pay(w, r.json().url);
    const tab = (await staff(w, "GET", `/checks/${w.ids["chk_room9"]}`)).json();
    expect(tab.payments).toEqual([
      expect.objectContaining({
        kind: "share",
        name: "Kevin",
        share_no: 1,
        shares: 12,
        amount_cents: 4155,
      }),
    ]);
    expect((await guest(w, phones[1]!, "GET", "/bill")).json().presented.payments[0]).toMatchObject(
      {
        name: "Kevin",
        share_no: 1,
      },
    );
  });

  it("two guests at once each get their own share", async () => {
    const [a, b] = await Promise.all([
      guest(w, phones[2]!, "POST", "/shares", { kind: "even" }),
      guest(w, phones[3]!, "POST", "/shares", { kind: "even" }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(a.json().share.share_no).not.toBe(b.json().share.share_no);
    await Promise.all([pay(w, a.json().url), pay(w, b.json().url)]);
  });

  it("after ten shares, staff take the other $83.10 and the last two guests see nothing left to pay", async () => {
    for (const phone of phones.slice(4, 11)) {
      const r = await guest(w, phone, "POST", "/shares", { kind: "even" });
      await pay(w, r.json().url);
    }
    const tab = (await staff(w, "GET", `/checks/${w.ids["chk_room9"]}`)).json();
    expect(tab.amount_due_cents).toBe(8310);
    const cash = await staff(w, "POST", `/checks/${w.ids["chk_room9"]}/payments`, {
      method: "cash",
      amount_cents: 8310,
      tendered_cents: 8310,
    });
    expect(cash.statusCode, cash.body).toBe(201);
    const bill = (await guest(w, phones[11]!, "GET", "/bill")).json();
    expect(bill).toMatchObject({ ended: true, presented: { status: "paid", amount_due_cents: 0 } });
    const shares = await w.owner.query(
      "select count(*)::int as n from payments where method = 'card_online' and status = 'captured' and booking_id is null",
    );
    expect(shares.rows[0].n).toBe(10);
  });
});

describe("twelve guests paying at once", () => {
  let w: World;
  beforeAll(async () => {
    w = await world("cancelled");
  });
  afterAll(() => drop(w));

  it("twelve $41.55 payments, no share paid twice, and #1042 is paid to the cent", async () => {
    const phones = await guests(w);
    const started = await Promise.all(
      phones.map((p) => guest(w, p, "POST", "/shares", { kind: "even" })),
    );
    expect(started.map((r) => r.statusCode)).toEqual(Array(12).fill(201));
    expect(new Set(started.map((r) => r.json().share.share_no)).size).toBe(12);
    await Promise.all(started.map((r) => pay(w, r.json().url)));
    const paid = await w.owner.query<{ amount_cents: string }>(
      `select a.amount_cents from payment_allocations a join payments p on p.id = a.payment_id
        where a.check_id = $1 and a.share_id is not null and a.state = 'captured'`,
      [w.ids["chk_room9"]],
    );
    expect(paid.rows.map((r) => Number(r.amount_cents))).toEqual(Array(12).fill(4155));
    expect(
      (await w.owner.query("select status from checks where id = $1", [w.ids["chk_room9"]])).rows[0]
        .status,
    ).toBe("paid");
  });
});

describe("with the margaritas accepted first", () => {
  let w: World;
  beforeAll(async () => {
    w = await world("accepted");
  });
  afterAll(() => drop(w));

  it("shares 1 to 3 are $44.35 and shares 4 to 12 are $44.34, adding up to $532.11", async () => {
    const phones = await guests(w);
    const r = await guest(w, phones[0]!, "POST", "/shares", { kind: "even" });
    expect(r.json().share).toMatchObject({
      share_no: 1,
      share_cents: 4435,
      tax_cents: 375,
      gratuity_cents: 844,
    });
    const all = await w.owner.query<{ amount_cents: string }>(
      `select s.amount_cents from split_shares s join check_splits k on k.id = s.split_id
        where k.check_id = $1 order by s.share_no`,
      [w.ids["chk_room9"]],
    );
    const amounts = all.rows.map((x) => Number(x.amount_cents));
    expect(amounts).toEqual([4435, 4435, 4435, ...Array(9).fill(4434)]);
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(53211);
  });
});

describe("My items", () => {
  let w: World;
  beforeAll(async () => {
    w = await world("cancelled");
  });
  afterAll(() => drop(w));

  it("splits by item over the party size, and the shares still add up to what's left", async () => {
    const phones = await guests(w);
    const r = await guest(w, phones[0]!, "POST", "/shares", { kind: "items" });
    expect(r.statusCode, r.body).toBe(201);
    const all = await w.owner.query<{ kind: string; amount_cents: string }>(
      `select s.kind, s.amount_cents from split_shares s join check_splits k on k.id = s.split_id
        where k.check_id = $1 order by s.share_no`,
      [w.ids["chk_room9"]],
    );
    expect(all.rows).toHaveLength(12);
    expect(all.rows.every((x) => x.kind === "items")).toBe(true);
    expect(all.rows.reduce((a, x) => a + Number(x.amount_cents), 0)).toBe(49860);
  });
});
