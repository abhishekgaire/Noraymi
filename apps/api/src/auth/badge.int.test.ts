import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import {
  badgeUidHash,
  parseAuthSecretKey,
  pinVerifier,
  tagFileReadKey,
  venueBadgeKeys,
} from "@west4/db";
import {
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, makeDeviceKey, signDeviceRequest } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { FakeBadge } from "./test-badge.js";
import { SoftwarePasskey } from "./test-passkey.js";

/**
 * M1-25 acceptance: a tap from Maya's badge signs her in on the bar computer
 * in under 300 ms; the same SUN message twice is refused; a tag with her UID
 * but another key's CMAC is refused, and so is a counter below the last;
 * Diego's tap while she's signed in takes over at once; a disabled badge is
 * refused. Pairing and switching off go through Admin → Team.
 */
const ORIGIN = "http://localhost:5173";
const KEY = "c".repeat(64);
const secret = parseAuthSecretKey(KEY);
const OWNER_EMAIL = "owner-a@example.com";

let db: TestDatabase;
let v: TwoVenues;
let app: FastifyInstance;
let owner: pg.Pool;
const clock = new SimulatedClock(SEED_NOW);

type Device = { id: string; key: Awaited<ReturnType<typeof makeDeviceKey>> };
let bar: Device;
let maya = "";
let diego = "";
let mayaBadge: FakeBadge;
let diegoBadge: FakeBadge;
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

async function person(name: string, role: string, pin: string): Promise<string> {
  const u = await owner.query<{ id: string }>("insert into users (name) values ($1) returning id", [
    name,
  ]);
  const m = await owner.query<{ id: string }>(
    `insert into memberships (venue_id, user_id, role, status, pin_digits, locale)
     values ($1, $2, $3, 'active', $4, 'en') returning id`,
    [v.venueA, u.rows[0]!.id, role, pin.length],
  );
  await owner.query("update memberships set pin_verifier = $2 where id = $1", [
    m.rows[0]!.id,
    await pinVerifier(secret, v.venueA, m.rows[0]!.id, pin),
  ]);
  return m.rows[0]!.id;
}

async function sharedDevice(
  kind: "bar_computer" | "front_desk" | "staff_phone",
  name: string,
): Promise<Device> {
  const key = await makeDeviceKey();
  const r = await owner.query<{ id: string }>(
    "insert into devices (venue_id, kind, name, public_key) values ($1, $2, $3, $4) returning id",
    [v.venueA, kind, name, JSON.stringify(key.publicJwk)],
  );
  return { id: r.rows[0]!.id, key };
}

async function tap(device: Device, sun: unknown) {
  const payload = JSON.stringify({ sun });
  const headers = await signDeviceRequest({
    deviceId: device.id,
    privateKey: device.key.privateKey,
    method: "POST",
    path: "/v1/auth/badge",
    body: payload,
  });
  return app.inject({
    method: "POST",
    url: "/v1/auth/badge",
    headers: { ...headers, "content-type": "application/json" },
    payload,
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
  app = buildApp({ config, clock, moduleCacheMs: 0 });
  await app.ready();
  maya = await person("Maya S.", "bartender", "4071");
  diego = await person("Diego R.", "front_desk", "6358");
  bar = await sharedDevice("bar_computer", "Bar computer");
  // Maya's badge is paired the way the seed does it; Diego's is paired through Admin below.
  mayaBadge = new FakeBadge({ secret, venueId: v.venueA, badgeId: "badge_maya" });
  await owner.query(
    "insert into staff_badges (venue_id, membership_id, uid_hash, label) values ($1, $2, $3, 'badge_maya')",
    [v.venueA, maya, badgeUidHash(v.venueA, mayaBadge.uid)],
  );
  diegoBadge = new FakeBadge({ secret, venueId: v.venueA, badgeId: "badge_diego" });
  // The owner's passkey session for Admin → Team.
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

describe("badges by their SUN message", () => {
  let mayaToken = "";
  let lastSun: unknown;

  it("a tap from Maya's badge signs her in on the bar computer, in under 300 ms", async () => {
    lastSun = mayaBadge.tap();
    const started = performance.now();
    const r = await tap(bar, lastSun);
    const elapsed = performance.now() - started;
    expect(r.statusCode, r.body).toBe(200);
    expect(elapsed).toBeLessThan(300);
    const body = json(r);
    expect((body["session"] as { assurance: string }).assurance).toBe("badge");
    expect(body["membership"]).toMatchObject({ id: maya, role: "bartender" });
    expect(body["badge"]).toMatchObject({ label: "badge_maya" });
    mayaToken = body["token"] as string;
    const me = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${mayaToken}` },
    });
    expect(me.statusCode).toBe(200);
    const row = await owner.query<{ last_counter: number }>(
      "select last_counter from staff_badges where membership_id = $1",
      [maya],
    );
    expect(row.rows[0]!.last_counter).toBe(1);
  });

  it("the same message twice is refused: a replayed read", async () => {
    const again = await tap(bar, lastSun);
    expect(again.statusCode).toBe(403);
    expect(json(again).error?.message).toBe("that read was already used");
    // The URL form the reader may hand over works the same.
    const next = mayaBadge.tap();
    const url = await tap(bar, `https://w4.example/t?e=${next.picc_data}&c=${next.cmac}`);
    expect(url.statusCode, url.body).toBe(200);
    mayaToken = json(url)["token"] as string;
  });

  it("a tag with Maya's UID but another key's CMAC is refused, and so is a counter below the last", async () => {
    const otherKey = tagFileReadKey(venueBadgeKeys(secret, v.venueA, 1).master, diegoBadge.uid);
    const copied = await tap(bar, FakeBadge.copyOf(mayaBadge, otherKey));
    expect(copied.statusCode).toBe(403);
    expect(json(copied).error?.message).toBe("this badge isn't genuine");
    const stale = new FakeBadge({ secret, venueId: v.venueA, badgeId: "badge_maya" });
    const older = await tap(bar, stale.tap()); // counter 1, below the 2 already seen
    expect(older.statusCode).toBe(403);
    expect(json(older).error?.message).toBe("that read was already used");
    const row = await owner.query<{ last_counter: number }>(
      "select last_counter from staff_badges where membership_id = $1",
      [maya],
    );
    expect(row.rows[0]!.last_counter).toBe(2);
  });

  it("Diego's badge is paired in Admin → Team by tapping it, and his tap takes over the bar computer at once", async () => {
    const without = await post(
      `/v1/venues/${v.venueA}/team/${diego}/badges`,
      { sun: diegoBadge.tap(), label: "Diego's fob" },
      { cookie: ownerCookie },
    );
    expect(without.statusCode).toBe(403);
    const paired = await post(
      `/v1/venues/${v.venueA}/team/${diego}/badges`,
      { sun: diegoBadge.tap(), label: "Diego's fob" },
      await stepUp(),
    );
    expect(paired.statusCode, paired.body).toBe(201);
    const badgeId = (json(paired)["badge"] as { id: string }).id;
    const twice = await post(
      `/v1/venues/${v.venueA}/team/${maya}/badges`,
      { sun: diegoBadge.tap() },
      await stepUp(),
    );
    expect(twice.statusCode).toBe(409);

    const takeover = await tap(bar, diegoBadge.tap());
    expect(takeover.statusCode, takeover.body).toBe(200);
    expect(json(takeover)["membership"]).toMatchObject({ id: diego, role: "front_desk" });
    const mayaNow = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${mayaToken}` },
    });
    expect(mayaNow.statusCode).not.toBe(200);
    const ended = await owner.query<{ end_reason: string }>(
      "select end_reason from auth_sessions where membership_id = $1 order by started_at desc limit 1",
      [maya],
    );
    expect(ended.rows[0]!.end_reason).toBe("replaced");

    const list = await app.inject({
      method: "GET",
      url: `/v1/venues/${v.venueA}/team/${diego}/badges`,
      headers: { cookie: ownerCookie },
    });
    expect(json(list)["badges"]).toEqual([
      expect.objectContaining({ id: badgeId, label: "Diego's fob" }),
    ]);
    const off = await post(`/v1/venues/${v.venueA}/badges/${badgeId}/disable`, {}, await stepUp());
    expect(off.statusCode, off.body).toBe(200);
    const disabled = await tap(bar, diegoBadge.tap());
    expect(disabled.statusCode).toBe(403);
    expect(json(disabled).error?.message).toBe("this badge was switched off");
  });

  it("a deactivated person, a phone or an unsigned request can't use a badge", async () => {
    await owner.query("update memberships set status = 'deactivated' where id = $1", [maya]);
    const gone = await tap(bar, mayaBadge.tap());
    expect(gone.statusCode).toBe(403);
    expect(json(gone).error?.message).toBe("this person no longer works here");
    await owner.query("update memberships set status = 'active' where id = $1", [maya]);
    const phone = await sharedDevice("staff_phone", "A phone");
    expect((await tap(phone, mayaBadge.tap())).statusCode).toBe(403);
    const unsigned = await app.inject({
      method: "POST",
      url: "/v1/auth/badge",
      payload: { sun: mayaBadge.tap() },
    });
    expect(unsigned.statusCode).toBe(403);
  });

  it("the bar computer registers its USB reader once, and the owner gets a tag's keys for pairing (M1-30)", async () => {
    const path = `/v1/venues/${v.venueA}/devices/attached`;
    const body = {
      kind: "nfc_reader",
      name: "ACR1252 USB",
      serial: "ACS ACR1252 1S CL Reader PICC 0",
    };
    const payload = JSON.stringify(body);
    const sign = () =>
      signDeviceRequest({
        deviceId: bar.id,
        privateKey: bar.key.privateKey,
        method: "POST",
        path,
        body: payload,
      });
    const first = await app.inject({
      method: "POST",
      url: path,
      headers: { ...(await sign()), "content-type": "application/json" },
      payload,
    });
    expect(first.statusCode, first.body).toBe(201);
    const readerId = json(first)["device_id"] as string;
    const again = await app.inject({
      method: "POST",
      url: path,
      headers: { ...(await sign()), "content-type": "application/json" },
      payload,
    });
    expect(again.statusCode).toBe(200);
    expect(json(again)["device_id"]).toBe(readerId);
    const row = await owner.query<{ kind: string; host_device_id: string }>(
      "select kind, host_device_id from devices where id = $1",
      [readerId],
    );
    expect(row.rows[0]!.kind).toBe("nfc_reader");
    expect(row.rows[0]!.host_device_id).toBe(bar.id);
    const unsigned = await app.inject({ method: "POST", url: path, payload: body });
    expect(unsigned.statusCode).toBe(403);

    const keys = await post(
      `/v1/venues/${v.venueA}/team/${diego}/badges/keys`,
      { uid: "04DE5F1EACC040" },
      { cookie: ownerCookie },
    );
    expect(keys.statusCode, keys.body).toBe(200);
    const expected = venueBadgeKeys(secret, v.venueA, 1);
    expect(json(keys)).toMatchObject({
      key_version: 1,
      meta_read_key: expected.metaRead.toString("hex"),
      file_read_key: tagFileReadKey(expected.master, Buffer.from("04DE5F1EACC040", "hex")).toString(
        "hex",
      ),
    });
    const bad = await post(
      `/v1/venues/${v.venueA}/team/${diego}/badges/keys`,
      { uid: "nope" },
      { cookie: ownerCookie },
    );
    expect(bad.statusCode).toBe(400);
  });
});
