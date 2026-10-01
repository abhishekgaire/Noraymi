import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import pg from "pg";
import { badgeUidHash, parseAuthSecretKey, pinVerifier } from "@west4/db";
import {
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, makeDeviceKey, signDeviceRequest } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { FakeBadge } from "../auth/test-badge.js";
import { SoftwarePasskey } from "../auth/test-passkey.js";

/**
 * M1-27 acceptance: deactivating Diego ends his sessions on the front-desk
 * computer and his phone, revokes his phone's key, closes his sockets and
 * revokes his push subscriptions, all within a second; his badge and PIN are
 * refused everywhere afterwards; his audit rows and every row he made are
 * still there and still name him.
 */
const ORIGIN = "http://localhost:5173";
const KEY = "d".repeat(64);
const secret = parseAuthSecretKey(KEY);
const OWNER_EMAIL = "owner-a@example.com";

let db: TestDatabase;
let v: TwoVenues;
let app: FastifyInstance;
let owner: pg.Pool;
let baseUrl = "";
const clock = new SimulatedClock(SEED_NOW);

type Device = { id: string; key: Awaited<ReturnType<typeof makeDeviceKey>> };
let desk: Device;
let phone: Device;
let diego = "";
let diegoUser = "";
let badge: FakeBadge;
const ownerKey = new SoftwarePasskey("localhost");
let ownerCookie = "";

const json = (r: { body: string }) =>
  JSON.parse(r.body) as Record<string, unknown> & { error?: { code: string; message: string } };
const cookieOf = (r: { headers: Record<string, unknown> }) => {
  const raw = r.headers["set-cookie"];
  const line = Array.isArray(raw) ? raw[0] : raw;
  return typeof line === "string" ? line.split(";")[0]! : "";
};
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, payload: body as Record<string, unknown>, headers });

async function signed(
  device: Device,
  method: "POST" | "GET",
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const headers = await signDeviceRequest({
    deviceId: device.id,
    privateKey: device.key.privateKey,
    method,
    path,
    body: payload,
  });
  return app.inject({
    method,
    url: path,
    headers: {
      ...headers,
      ...extra,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { payload }),
  });
}

async function latestEmailCode(to: string): Promise<string> {
  const r = await owner.query<{ payload: { data: { code: string } } }>(
    "select payload from jobs where kind = 'email.send' and payload->>'to' = $1 order by created_at desc limit 1",
    [to],
  );
  return r.rows[0]!.payload.data.code;
}

async function stepUp(): Promise<Record<string, string>> {
  const start = json(await post("/v1/auth/step-up", { step: "start" }, { cookie: ownerCookie }));
  const finish = json(
    await post(
      "/v1/auth/step-up",
      {
        step: "finish",
        credential: ownerKey.assert(start["options"] as { challenge: string }, ORIGIN),
      },
      { cookie: ownerCookie },
    ),
  );
  return { cookie: ownerCookie, "x-step-up": finish["step_up_token"] as string };
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  owner = new pg.Pool({ connectionString: db.url, max: 2 });
  await owner.query("update users set email = $2 where id = $1", [v.ownerA, OWNER_EMAIL]);
  const config = loadConfig({
    WEST4_ENV: "local",
    DATABASE_URL: db.url,
    APP_DATABASE_URL: db.url,
    AUTH_SECRET_KEY: KEY,
    WEBAUTHN_RP_ID: "localhost",
    WEBAUTHN_ORIGINS: ORIGIN,
  });
  app = buildApp({ config, clock, moduleCacheMs: 0, eventsPollMs: 100 });
  await app.ready();
  baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  // Diego: front desk, a PIN, a badge, a phone.
  const u = await owner.query<{ id: string }>(
    "insert into users (name) values ('Diego R.') returning id",
  );
  diegoUser = u.rows[0]!.id;
  const m = await owner.query<{ id: string }>(
    "insert into memberships (venue_id, user_id, role, status, pin_digits, locale) values ($1, $2, 'front_desk', 'active', 4, 'en') returning id",
    [v.venueA, diegoUser],
  );
  diego = m.rows[0]!.id;
  await owner.query("update memberships set pin_verifier = $2 where id = $1", [
    diego,
    await pinVerifier(secret, v.venueA, diego, "6358"),
  ]);
  badge = new FakeBadge({ secret, venueId: v.venueA, badgeId: "badge_diego" });
  await owner.query(
    "insert into staff_badges (venue_id, membership_id, uid_hash, label) values ($1, $2, $3, 'fob')",
    [v.venueA, diego, badgeUidHash(v.venueA, badge.uid)],
  );
  const deskKey = await makeDeviceKey();
  const d = await owner.query<{ id: string }>(
    "insert into devices (venue_id, kind, name, public_key) values ($1, 'front_desk', 'Front desk', $2) returning id",
    [v.venueA, JSON.stringify(deskKey.publicJwk)],
  );
  desk = { id: d.rows[0]!.id, key: deskKey };
  const phoneKey = await makeDeviceKey();
  const ph = await owner.query<{ id: string }>(
    "insert into devices (venue_id, kind, name, user_id, public_key) values ($1, 'staff_phone', 'iPhone', $2, $3) returning id",
    [v.venueA, diegoUser, JSON.stringify(phoneKey.publicJwk)],
  );
  phone = { id: ph.rows[0]!.id, key: phoneKey };
  // The owner's passkey session.
  expect((await post("/v1/auth/enroll", { step: "start", email: OWNER_EMAIL })).statusCode).toBe(
    200,
  );
  const code = await latestEmailCode(OWNER_EMAIL);
  const opts = json(
    await post("/v1/auth/enroll", { step: "passkey_options", email: OWNER_EMAIL, code }),
  );
  const finish = await post("/v1/auth/enroll", {
    step: "passkey_finish",
    email: OWNER_EMAIL,
    code,
    credential: ownerKey.register(opts["options"] as { challenge: string }, ORIGIN),
    name: "Owner phone",
    client: "web",
  });
  expect(finish.statusCode, finish.body).toBe(201);
  ownerCookie = cookieOf(finish);
});

afterAll(async () => {
  await app.close();
  await owner.end();
  await db.drop();
});

describe("offboarding in one step", () => {
  let deskToken = "";
  let phoneCookie = "";
  let socketClosed: Promise<number>;

  it("Diego is at work: signed in at the front desk and on his phone, subscribed to push, with a socket open", async () => {
    const desk1 = await signed(desk, "POST", "/v1/auth/pin", {
      membership_id: diego,
      pin: "6358",
      client: "shared",
    });
    expect(desk1.statusCode, desk1.body).toBe(200);
    deskToken = json(desk1)["token"] as string;
    const phone1 = await signed(phone, "POST", "/v1/auth/pin", { pin: "6358", client: "phone" });
    expect(phone1.statusCode, phone1.body).toBe(200);
    phoneCookie = cookieOf(phone1);
    expect(phoneCookie).toMatch(/^west4_session=/);
    // His phone saves its push subscription under his own session: a row he made, audited as him.
    const sub = await signed(
      phone,
      "POST",
      `/v1/venues/${v.venueA}/push/subscriptions`,
      { endpoint: "https://push.example.test/diego", keys: { p256dh: "k", auth: "a" } },
      { cookie: phoneCookie },
    );
    expect(sub.statusCode, sub.body).toBe(201);
    const path = `/v1/venues/${v.venueA}/events`;
    const ws = new WebSocket(`${baseUrl.replace("http", "ws")}${path}`, {
      headers: { cookie: phoneCookie },
    });
    socketClosed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    const hello = await new Promise<Record<string, unknown>>((resolve, reject) => {
      ws.once("message", (d) => resolve(JSON.parse(String(d)) as Record<string, unknown>));
      ws.once("error", reject);
    });
    expect(hello["type"]).toBe("hello");
  });

  it("a manager, or the owner without the passkey step-up, can't deactivate him; he can't deactivate himself", async () => {
    const without = await post(
      `/v1/venues/${v.venueA}/team/${diego}/deactivate`,
      {},
      { cookie: ownerCookie },
    );
    expect(without.statusCode).toBe(403);
    expect(json(without).error?.code).toBe("step_up_required");
    const asDiego = await post(
      `/v1/venues/${v.venueA}/team/${diego}/deactivate`,
      {},
      { authorization: `Bearer ${deskToken}` },
    );
    expect(asDiego.statusCode).toBe(403);
  });

  it("deactivating Diego ends his sessions, revokes his phone, closes his socket and revokes his subscriptions, within a second", async () => {
    const started = Date.now();
    const r = await post(`/v1/venues/${v.venueA}/team/${diego}/deactivate`, {}, await stepUp());
    expect(r.statusCode, r.body).toBe(200);
    expect(json(r)).toMatchObject({ badges_disabled: 1, phones_revoked: 1, sessions_ended: 2 });
    expect(await socketClosed).toBe(4401);
    expect(Date.now() - started).toBeLessThan(1000);
    const deskNow = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${deskToken}` },
    });
    expect(deskNow.statusCode).not.toBe(200);
    const phoneNow = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { cookie: phoneCookie },
    });
    expect(phoneNow.statusCode).not.toBe(200);
    const device = await owner.query<{ revoked_at: string | null }>(
      "select revoked_at::text from devices where id = $1",
      [phone.id],
    );
    expect(device.rows[0]!.revoked_at).not.toBeNull();
    const subs = await owner.query<{ revoked_at: string | null }>(
      "select revoked_at::text from push_subscriptions where device_id = $1",
      [phone.id],
    );
    expect(subs.rows).toHaveLength(1);
    expect(subs.rows[0]!.revoked_at).not.toBeNull();
    // The phone's key is dead: its signature is refused.
    const signedAgain = await signed(phone, "POST", "/v1/auth/pin", {
      pin: "6358",
      client: "phone",
    });
    expect(signedAgain.statusCode).toBe(403);
    const again = await post(`/v1/venues/${v.venueA}/team/${diego}/deactivate`, {}, await stepUp());
    expect(again.statusCode).toBe(404);
  });

  it("his badge and PIN are refused everywhere afterwards", async () => {
    const pin = await signed(desk, "POST", "/v1/auth/pin", {
      membership_id: diego,
      pin: "6358",
      client: "shared",
    });
    expect(pin.statusCode).toBe(401);
    const tap = await signed(desk, "POST", "/v1/auth/badge", { sun: badge.tap() });
    expect(tap.statusCode).toBe(403);
    expect(json(tap).error?.message).toMatch(/switched off|no longer works here/);
    const tiles = json(await signed(desk, "GET", `/v1/venues/${v.venueA}/team/tiles`));
    expect(
      (tiles["tiles"] as { membership_id: string }[]).map((t) => t.membership_id),
    ).not.toContain(diego);
  });

  it("his audit rows and every row he made are still there and still name him", async () => {
    const membership = await owner.query<{
      status: string;
      user_id: string;
      deactivated_at: string | null;
    }>("select status, user_id, deactivated_at::text from memberships where id = $1", [diego]);
    expect(membership.rows[0]).toMatchObject({ status: "deactivated", user_id: diegoUser });
    expect(membership.rows[0]!.deactivated_at).not.toBeNull();
    const user = await owner.query<{ name: string }>("select name from users where id = $1", [
      diegoUser,
    ]);
    expect(user.rows[0]!.name).toBe("Diego R.");
    const his = await owner.query<{ count: string }>(
      "select count(*)::text from audit_log where actor = $1",
      [diegoUser],
    );
    expect(Number(his.rows[0]!.count)).toBeGreaterThan(0);
    const subscription = await owner.query<{ count: string }>(
      "select count(*)::text from audit_log where actor = $1 and target like 'push_subscriptions/%'",
      [diegoUser],
    );
    expect(Number(subscription.rows[0]!.count)).toBeGreaterThan(0);
    const rows = await owner.query<{ count: string }>(
      "select count(*)::text from push_subscriptions where device_id = $1",
      [phone.id],
    );
    expect(rows.rows[0]!.count).toBe("1");
  });
});
