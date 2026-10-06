import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { Worker, recordPunch } from "@west4/db";
import {
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, makeDeviceKey, signDeviceRequest } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { FakePushSender } from "../push/sender.js";
import { PUSH_SEND_KIND, makePushSendHandler, renderPush } from "../push/send-push.js";

/**
 * Web push for staff phones (M1-22). Bartender A's phone registers itself as
 * her staff_phone, signs its push subscription under her session, and a test
 * push reaches it through a fake push endpoint. A revoked device's
 * subscription receives nothing, and an endpoint the push service says is
 * gone is revoked.
 */
let db: TestDatabase;
let v: TwoVenues;
let app: FastifyInstance;
let owner: pg.Pool;
const clock = new FrozenClock(SEED_NOW);

const headerAuth = async (request: { headers: Record<string, unknown> }) => {
  const raw = request.headers["x-test-principal"];
  return typeof raw === "string" ? (JSON.parse(raw) as Principal) : undefined;
};

const as = (userId: string, role: "owner" | "bartender"): Record<string, string> => ({
  "x-test-principal": JSON.stringify({
    kind: "user",
    userId,
    session: role === "owner" ? "passkey" : "pin",
    memberships: [{ venueId: v.venueA, membershipId: `m-${role}`, role }],
  } satisfies Principal),
});

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  owner = new pg.Pool({ connectionString: db.url, max: 2 });
  const config = loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url });
  app = buildApp({
    config,
    clock,
    authenticators: [headerAuth],
    eventsPollMs: 100,
    moduleCacheMs: 0,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await owner.end();
  await db.drop();
});

describe("a staff phone subscribes to push", () => {
  let deviceId = "";
  let key: Awaited<ReturnType<typeof makeDeviceKey>>;
  const endpoint = "https://push.example.test/send/bartender-a";
  const sender = new FakePushSender();
  const worker = () =>
    new Worker(owner, {
      pool: "normal",
      handlers: { [PUSH_SEND_KIND]: makePushSendHandler(sender) },
      clock,
      random: () => 0.5,
    });

  const subscribe = async (headers: Record<string, string>, body: unknown) => {
    const path = `/v1/venues/${v.venueA}/push/subscriptions`;
    const payload = JSON.stringify(body);
    const signed = await signDeviceRequest({
      deviceId,
      privateKey: key.privateKey,
      method: "POST",
      path,
      body: payload,
    });
    return app.inject({
      method: "POST",
      url: path,
      headers: { ...signed, ...headers, "content-type": "application/json" },
      payload,
    });
  };

  it("publishes the VAPID public key", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/push/vapid-key" });
    expect(r.statusCode).toBe(200);
    expect(r.json().public_key).toMatch(/^[A-Za-z0-9_-]{80,}$/);
  });

  it("her phone becomes her staff_phone device", async () => {
    key = await makeDeviceKey();
    const r = await app.inject({
      method: "POST",
      url: `/v1/venues/${v.venueA}/devices/staff-phone`,
      headers: as(v.bartenderA, "bartender"),
      payload: { name: "Maya's phone", public_key: key.publicJwk },
    });
    expect(r.statusCode, r.body).toBe(201);
    deviceId = r.json().device_id;
    const row = await owner.query("select kind, user_id from devices where id = $1", [deviceId]);
    expect(row.rows[0]).toEqual({ kind: "staff_phone", user_id: v.bartenderA });
  });

  it("saves a subscription signed by the phone under her own session, and refuses anyone else's", async () => {
    const body = { endpoint, keys: { p256dh: "p256dh-key", auth: "auth-secret" } };
    const unsigned = await app.inject({
      method: "POST",
      url: `/v1/venues/${v.venueA}/push/subscriptions`,
      headers: as(v.bartenderA, "bartender"),
      payload: body,
    });
    expect(unsigned.statusCode).toBe(403);
    const someoneElse = await subscribe(as(v.ownerA, "owner"), body);
    expect(someoneElse.statusCode, someoneElse.body).toBe(403);
    const ok = await subscribe(as(v.bartenderA, "bartender"), body);
    expect(ok.statusCode, ok.body).toBe(201);
    // The same endpoint again refreshes the keys instead of adding a row.
    const again = await subscribe(as(v.bartenderA, "bartender"), {
      ...body,
      keys: { p256dh: "p256dh-key-2", auth: "auth-secret" },
    });
    expect(again.statusCode, again.body).toBe(201);
    const rows = await owner.query("select keys from push_subscriptions where device_id = $1", [
      deviceId,
    ]);
    expect(rows.rows).toEqual([{ keys: { p256dh: "p256dh-key-2", auth: "auth-secret" } }]);
  });

  it("a test push reaches her phone, in her language, through the push endpoint", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/v1/venues/${v.venueA}/push/test`,
      headers: as(v.bartenderA, "bartender"),
    });
    expect(r.statusCode, r.body).toBe(202);
    expect(await worker().tick()).toBe(1);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.endpoint).toBe(endpoint);
    const shown = JSON.parse(sender.sent[0]!.payload) as {
      title: string;
      body: string;
      url: string;
    };
    expect(shown.body).toBe("Test alert · this phone gets alerts from the staff app");
    expect(shown.url).toBe("/setup");
    expect(shown.title).not.toBe("");
    // A push to a role reaches the same phone; one to another role reaches nobody.
    await owner.query("update memberships set locale = 'es' where user_id = $1", [v.bartenderA]);
    await owner.query(
      `insert into jobs (venue_id, kind, pool, payload, run_at)
       values ($1, $2, 'normal', $3, $5), ($1, $2, 'normal', $4, $5)`,
      [
        v.venueA,
        PUSH_SEND_KIND,
        JSON.stringify({
          audience: { kind: "role", role: "bartender" },
          message: { key: "push.test.body" },
        }),
        JSON.stringify({
          audience: { kind: "role", role: "manager" },
          message: { key: "push.test.body" },
        }),
        SEED_NOW.toString(),
      ],
    );
    const w = worker();
    expect((await w.tick()) + (await w.tick())).toBe(2);
    expect(sender.sent).toHaveLength(2);
    expect(JSON.parse(sender.sent[1]!.payload).body).toMatch(/^Alerta de prueba/);
    expect(renderPush("West 4", "es", { key: "push.test.body" })).toContain('"title":"West 4"');
  });

  it("the bar buzz reaches bar-role phones only while their person is on the clock (M7-01)", async () => {
    const buzz = JSON.stringify({
      audience: { kind: "bar_on_clock" },
      message: { key: "push.test.body" },
    });
    const queue = () =>
      owner.query(
        "insert into jobs (venue_id, kind, pool, payload, run_at) values ($1, $2, 'normal', $3, $4)",
        [v.venueA, PUSH_SEND_KIND, buzz, SEED_NOW.toString()],
      );
    const before = sender.sent.length;
    await queue();
    expect(await worker().tick()).toBe(1);
    expect(sender.sent).toHaveLength(before);
    const m = await owner.query<{ id: string }>(
      "select id from memberships where venue_id = $1 and user_id = $2",
      [v.venueA, v.bartenderA],
    );
    await recordPunch(owner, {
      venueId: v.venueA,
      membershipId: m.rows[0]!.id,
      kind: "clock_in",
      duty: "bar",
      at: SEED_NOW,
      venue: { timeZone: "America/New_York", dayCutover: "06:00" },
    });
    await queue();
    expect(await worker().tick()).toBe(1);
    expect(sender.sent).toHaveLength(before + 1);
  });

  it("an endpoint the push service says is gone is revoked", async () => {
    sender.gone.add(endpoint);
    await app.inject({
      method: "POST",
      url: `/v1/venues/${v.venueA}/push/test`,
      headers: as(v.bartenderA, "bartender"),
    });
    expect(await worker().tick()).toBe(1);
    const rows = await owner.query(
      "select revoked_at from push_subscriptions where device_id = $1",
      [deviceId],
    );
    expect(rows.rows[0]!.revoked_at).not.toBeNull();
    sender.gone.delete(endpoint);
    // Subscribing again revives it.
    const ok = await subscribe(as(v.bartenderA, "bartender"), {
      endpoint,
      keys: { p256dh: "p256dh-key-3", auth: "auth-secret" },
    });
    expect(ok.statusCode).toBe(201);
  });

  it("a revoked device's subscription receives nothing, and the phone can't subscribe again", async () => {
    const revoke = await app.inject({
      method: "POST",
      url: `/v1/venues/${v.venueA}/devices/${deviceId}/revoke`,
      headers: as(v.ownerA, "owner"),
    });
    expect(revoke.statusCode, revoke.body).toBe(200);
    const before = sender.sent.length;
    await app.inject({
      method: "POST",
      url: `/v1/venues/${v.venueA}/push/test`,
      headers: as(v.bartenderA, "bartender"),
    });
    expect(await worker().tick()).toBe(1);
    expect(sender.sent).toHaveLength(before);
    const again = await subscribe(as(v.bartenderA, "bartender"), {
      endpoint,
      keys: { p256dh: "p256dh-key-4", auth: "auth-secret" },
    });
    expect(again.statusCode).toBe(403);
  });
});
