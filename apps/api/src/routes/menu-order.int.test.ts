import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import {
  generateSigningKey,
  latestSetting,
  parseAuthSecretKey,
  pinVerifier,
  publishRulePack,
  withVenue,
} from "@west4/db";
import {
  appPool,
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "@west4/db/test-helpers";
import {
  SEED_NOW,
  SimulatedClock,
  makeDeviceKey,
  newYorkCounty,
  signDeviceRequest,
} from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { SoftwarePasskey } from "../auth/test-passkey.js";

/**
 * P-13 · the order of the menu: Admin → Features → Menu order saves the `menuOrder` key; every
 * person at the venue gets it on `GET /v1/auth/me` (`menu_order`), the front desk by PIN too; it
 * never crosses venues; only known entries, each once, and never Lock; only Admin may save it; the
 * API's own role (app_rw) reads it behind the venue wall.
 */
const ORIGIN = "http://localhost:5173";
const KEY = "e".repeat(64);
const secret = parseAuthSecretKey(KEY);
const OWNER_A = "owner-a@example.com";
const OWNER_B = "owner-b@example.com";

let db: TestDatabase;
let v: TwoVenues;
let app: FastifyInstance;
let owner: pg.Pool;
let rw: pg.Pool;
const clock = new SimulatedClock(SEED_NOW);
let diego = "";
let desk: { id: string; key: Awaited<ReturnType<typeof makeDeviceKey>> };
let cookieA = "";
let cookieB = "";

const json = (r: { body: string }) =>
  JSON.parse(r.body) as Record<string, unknown> & { error?: { code: string } };
const cookieOf = (r: { headers: Record<string, unknown> }) => {
  const raw = r.headers["set-cookie"];
  const line = Array.isArray(raw) ? raw[0] : raw;
  return typeof line === "string" ? line.split(";")[0]! : "";
};
const call = (
  method: "GET" | "POST" | "PUT",
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method,
    url,
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    headers,
  });

async function enrol(email: string): Promise<string> {
  const key = new SoftwarePasskey("localhost");
  expect((await call("POST", "/v1/auth/enroll", { step: "start", email })).statusCode).toBe(200);
  const r = await owner.query<{ payload: { data: { code: string } } }>(
    "select payload from jobs where kind = 'email.send' and payload->>'to' = $1 order by created_at desc limit 1",
    [email],
  );
  const code = r.rows[0]!.payload.data.code;
  const opts = json(
    await call("POST", "/v1/auth/enroll", { step: "passkey_options", email, code }),
  );
  const finish = await call("POST", "/v1/auth/enroll", {
    step: "passkey_finish",
    email,
    code,
    credential: key.register(opts["options"] as { challenge: string }, ORIGIN),
    name: "Phone",
    client: "web",
  });
  expect(finish.statusCode, finish.body).toBe(201);
  return cookieOf(finish);
}

async function diegoByPin(): Promise<Record<string, string>> {
  const path = "/v1/auth/pin";
  const payload = JSON.stringify({ membership_id: diego, pin: "6358", client: "shared" });
  const headers = await signDeviceRequest({
    deviceId: desk.id,
    privateKey: desk.key.privateKey,
    method: "POST",
    path,
    body: payload,
  });
  const r = await app.inject({
    method: "POST",
    url: path,
    headers: { ...headers, "content-type": "application/json" },
    payload,
  });
  expect(r.statusCode, r.body).toBe(200);
  return { authorization: `Bearer ${json(r)["token"] as string}` };
}

const orderOn = async (headers: Record<string, string>, venueId: string) => {
  const r = await call("GET", "/v1/auth/me", undefined, headers);
  expect(r.statusCode, r.body).toBe(200);
  const m = (json(r)["memberships"] as Array<{ venue_id: string; menu_order: string[] }>).find(
    (x) => x.venue_id === venueId,
  );
  return m?.menu_order;
};
const save = (venueId: string, order: unknown, cookie: string) =>
  call("PUT", `/v1/venues/${venueId}/settings/menuOrder`, { value: { order } }, { cookie });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  owner = new pg.Pool({ connectionString: db.url, max: 2 });
  rw = appPool(db.url);
  // A save checks the venue's rule pack, so the two venues need theirs.
  await publishRulePack(owner, {
    pack: newYorkCounty,
    effectiveOn: "2026-09-01",
    approvedBy: ["A", "B"],
    privateKeyPem: generateSigningKey().privateKeyPem,
  });
  await owner.query("update users set email = $2 where id = $1", [v.ownerA, OWNER_A]);
  await owner.query("update users set email = $2 where id = $1", [v.ownerB, OWNER_B]);
  const config = loadConfig({
    WEST4_ENV: "local",
    DATABASE_URL: db.url,
    APP_DATABASE_URL: db.url,
    AUTH_SECRET_KEY: KEY,
    WEBAUTHN_RP_ID: "localhost",
    WEBAUTHN_ORIGINS: ORIGIN,
    STAFF_APP_URL: ORIGIN,
  });
  app = buildApp({ config, clock, moduleCacheMs: 0 });
  await app.ready();
  const du = await owner.query<{ id: string }>(
    "insert into users (name) values ('Diego R.') returning id",
  );
  diego = (
    await owner.query<{ id: string }>(
      "insert into memberships (venue_id, user_id, role, status, pin_digits, locale) values ($1, $2, 'front_desk', 'active', 4, 'en') returning id",
      [v.venueA, du.rows[0]!.id],
    )
  ).rows[0]!.id;
  await owner.query("update memberships set pin_verifier = $2 where id = $1", [
    diego,
    await pinVerifier(secret, v.venueA, diego, "6358"),
  ]);
  const deskKey = await makeDeviceKey();
  const d = await owner.query<{ id: string }>(
    "insert into devices (venue_id, kind, name, public_key) values ($1, 'front_desk', 'Front desk', $2) returning id",
    [v.venueA, JSON.stringify(deskKey.publicJwk)],
  );
  desk = { id: d.rows[0]!.id, key: deskKey };
  cookieA = await enrol(OWNER_A);
  cookieB = await enrol(OWNER_B);
});

afterAll(async () => {
  await app?.close();
  await rw?.end();
  await owner?.end();
  await db?.drop();
});

describe("the venue's menu order (P-13)", () => {
  it("is the app's own order (an empty list) until the venue saves one", async () => {
    expect(await orderOn({ cookie: cookieA }, v.venueA)).toEqual([]);
    const r = await call("GET", `/v1/venues/${v.venueA}/settings/menuOrder`, undefined, {
      cookie: cookieA,
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(json(r)).toMatchObject({ version: 0, value: { order: [] } });
  });

  it("saved by the owner, it reaches everyone at the venue, the front desk by PIN too, and not venue B", async () => {
    const r = await save(v.venueA, ["admin", "reports", "barPos"], cookieA);
    expect(r.statusCode, r.body).toBe(200);
    expect(await orderOn({ cookie: cookieA }, v.venueA)).toEqual(["admin", "reports", "barPos"]);
    expect(await orderOn(await diegoByPin(), v.venueA)).toEqual(["admin", "reports", "barPos"]);
    expect(await orderOn({ cookie: cookieB }, v.venueB)).toEqual([]);
  });

  it("refuses an unknown entry, Lock, or one entry twice", async () => {
    for (const bad of [["nope"], ["lock"], ["admin", "admin"], "admin"]) {
      const r = await save(v.venueA, bad, cookieA);
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(await orderOn({ cookie: cookieA }, v.venueA)).toEqual(["admin", "reports", "barPos"]);
  });

  it("only Admin saves it: the front desk is refused, and venue B's owner can't touch venue A", async () => {
    const pin = await diegoByPin();
    const asDiego = await call(
      "PUT",
      `/v1/venues/${v.venueA}/settings/menuOrder`,
      { value: { order: ["clock"] } },
      pin,
    );
    expect(asDiego.statusCode).toBe(403);
    const asB = await save(v.venueA, ["clock"], cookieB);
    expect([403, 404]).toContain(asB.statusCode);
    expect(await orderOn({ cookie: cookieA }, v.venueA)).toEqual(["admin", "reports", "barPos"]);
  });

  it("the API's own role reads it behind the venue wall", async () => {
    const mine = await withVenue(rw, { venueId: v.venueA, userId: v.ownerA }, (c) =>
      latestSetting(c, v.venueA, "menuOrder"),
    );
    expect(mine?.value).toEqual({ order: ["admin", "reports", "barPos"] });
    const across = await withVenue(rw, { venueId: v.venueB, userId: v.ownerB }, (c) =>
      latestSetting(c, v.venueA, "menuOrder"),
    );
    expect(across).toBeNull();
  });
});
