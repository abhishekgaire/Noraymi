import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { parseAuthSecretKey, pinVerifier } from "@west4/db";
import {
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, makeDeviceKey, signDeviceRequest } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { SoftwarePasskey } from "../auth/test-passkey.js";

/**
 * M1-31 acceptance, API side: `GET /team` and `PATCH /team/{m}` are the
 * owner's alone (a manager with a passkey gets 403, the front desk too); a
 * language change makes Diego's next sign-in Spanish; a role change needs the
 * passkey again and lands in the audit log; moving between 4- and 6-digit
 * PINs clears the old PIN and sends a new link; nobody changes their own role.
 */
const ORIGIN = "http://localhost:5173";
const KEY = "e".repeat(64);
const secret = parseAuthSecretKey(KEY);
const OWNER_EMAIL = "owner-a@example.com";
const ANDY_EMAIL = "andy-a@example.com";

let db: TestDatabase;
let v: TwoVenues;
let app: FastifyInstance;
let owner: pg.Pool;
const clock = new SimulatedClock(SEED_NOW);
let diego = "";
let andy = "";
type Device = { id: string; key: Awaited<ReturnType<typeof makeDeviceKey>> };
let desk: Device;
const ownerKey = new SoftwarePasskey("localhost");
const andyKey = new SoftwarePasskey("localhost");
let ownerCookie = "";
let andyCookie = "";

const json = (r: { body: string }) =>
  JSON.parse(r.body) as Record<string, unknown> & { error?: { code: string; message: string } };
const cookieOf = (r: { headers: Record<string, unknown> }) => {
  const raw = r.headers["set-cookie"];
  const line = Array.isArray(raw) ? raw[0] : raw;
  return typeof line === "string" ? line.split(";")[0]! : "";
};
const call = (
  method: "GET" | "POST" | "PATCH",
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

async function latestEmailCode(to: string): Promise<string> {
  const r = await owner.query<{ payload: { data: { code: string } } }>(
    "select payload from jobs where kind = 'email.send' and payload->>'to' = $1 order by created_at desc limit 1",
    [to],
  );
  return r.rows[0]!.payload.data.code;
}

async function enrol(email: string, key: SoftwarePasskey): Promise<string> {
  expect((await call("POST", "/v1/auth/enroll", { step: "start", email })).statusCode).toBe(200);
  const code = await latestEmailCode(email);
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

async function stepUp(cookie: string, key: SoftwarePasskey): Promise<Record<string, string>> {
  const start = json(await call("POST", "/v1/auth/step-up", { step: "start" }, { cookie }));
  const finish = json(
    await call(
      "POST",
      "/v1/auth/step-up",
      { step: "finish", credential: key.assert(start["options"] as { challenge: string }, ORIGIN) },
      { cookie },
    ),
  );
  return { cookie, "x-step-up": finish["step_up_token"] as string };
}

async function signed(path: string, body: unknown) {
  const payload = JSON.stringify(body);
  const headers = await signDeviceRequest({
    deviceId: desk.id,
    privateKey: desk.key.privateKey,
    method: "POST",
    path,
    body: payload,
  });
  return app.inject({
    method: "POST",
    url: path,
    headers: { ...headers, "content-type": "application/json" },
    payload,
  });
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
    STAFF_APP_URL: ORIGIN,
  });
  app = buildApp({ config, clock, moduleCacheMs: 0 });
  await app.ready();
  const du = await owner.query<{ id: string }>(
    "insert into users (name) values ('Diego R.') returning id",
  );
  const dm = await owner.query<{ id: string }>(
    "insert into memberships (venue_id, user_id, role, status, pin_digits, locale) values ($1, $2, 'front_desk', 'active', 4, 'en') returning id",
    [v.venueA, du.rows[0]!.id],
  );
  diego = dm.rows[0]!.id;
  await owner.query("update memberships set pin_verifier = $2 where id = $1", [
    diego,
    await pinVerifier(secret, v.venueA, diego, "6358"),
  ]);
  const au = await owner.query<{ id: string }>(
    "insert into users (name, email) values ('Andy C.', $1) returning id",
    [ANDY_EMAIL],
  );
  const am = await owner.query<{ id: string }>(
    "insert into memberships (venue_id, user_id, role, status, pin_digits, locale) values ($1, $2, 'manager', 'active', 6, 'en') returning id",
    [v.venueA, au.rows[0]!.id],
  );
  andy = am.rows[0]!.id;
  const deskKey = await makeDeviceKey();
  const d = await owner.query<{ id: string }>(
    "insert into devices (venue_id, kind, name, public_key) values ($1, 'front_desk', 'Front desk', $2) returning id",
    [v.venueA, JSON.stringify(deskKey.publicJwk)],
  );
  desk = { id: d.rows[0]!.id, key: deskKey };
  ownerCookie = await enrol(OWNER_EMAIL, ownerKey);
  andyCookie = await enrol(ANDY_EMAIL, andyKey);
});

afterAll(async () => {
  await app.close();
  await owner.end();
  await db.drop();
});

describe("Admin → Team's list and PATCH /team/{m}", () => {
  it("the owner lists every person with role, state, language and badges; Andy (manager) and Diego get 403", async () => {
    const r = await call("GET", `/v1/venues/${v.venueA}/team`, undefined, { cookie: ownerCookie });
    expect(r.statusCode, r.body).toBe(200);
    const people = json(r)["people"] as Array<Record<string, unknown>>;
    const d = people.find((p) => p["membership_id"] === diego)!;
    expect(d).toMatchObject({
      name: "Diego R.",
      role: "front_desk",
      status: "active",
      locale: "en",
      has_pin: true,
      badges: [],
    });
    expect(people.some((p) => p["role"] === "owner")).toBe(true);

    const asAndy = await call("GET", `/v1/venues/${v.venueA}/team`, undefined, {
      cookie: andyCookie,
    });
    expect(asAndy.statusCode).toBe(403);
    const pinIn = await signed("/v1/auth/pin", {
      membership_id: diego,
      pin: "6358",
      client: "shared",
    });
    expect(pinIn.statusCode, pinIn.body).toBe(200);
    const asDiego = await call("GET", `/v1/venues/${v.venueA}/team`, undefined, {
      authorization: `Bearer ${json(pinIn)["token"] as string}`,
    });
    expect(asDiego.statusCode).toBe(403);
    // Venue B's team is behind the wall even for venue A's owner.
    expect(
      (await call("GET", `/v1/venues/${v.venueB}/team`, undefined, { cookie: ownerCookie }))
        .statusCode,
    ).toBe(403);
  });

  it("setting Diego's language to Español makes his next sign-in Spanish", async () => {
    const r = await call(
      "PATCH",
      `/v1/venues/${v.venueA}/team/${diego}`,
      { locale: "es" },
      await stepUp(ownerCookie, ownerKey),
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(json(r)).toMatchObject({ membership_id: diego, role: "front_desk", locale: "es" });
    const pinIn = await signed("/v1/auth/pin", {
      membership_id: diego,
      pin: "6358",
      client: "shared",
    });
    expect(pinIn.statusCode, pinIn.body).toBe(200);
    const me = json(
      await call("GET", "/v1/auth/me", undefined, {
        authorization: `Bearer ${json(pinIn)["token"] as string}`,
      }),
    );
    const membership = (me["memberships"] as Array<Record<string, unknown>>)[0]!;
    expect(membership["locale"]).toBe("es");
  });

  it("a role change asks for the passkey again, writes an audit row, and a manager can't make it", async () => {
    const without = await call(
      "PATCH",
      `/v1/venues/${v.venueA}/team/${diego}`,
      { role: "staff" },
      { cookie: ownerCookie },
    );
    expect(without.statusCode).toBe(403);
    expect(json(without).error?.code).toBe("step_up_required");
    const asAndy = await call(
      "PATCH",
      `/v1/venues/${v.venueA}/team/${diego}`,
      { role: "staff" },
      await stepUp(andyCookie, andyKey),
    );
    expect(asAndy.statusCode).toBe(403);

    const r = await call(
      "PATCH",
      `/v1/venues/${v.venueA}/team/${diego}`,
      { role: "staff" },
      await stepUp(ownerCookie, ownerKey),
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(json(r)).toMatchObject({ role: "staff", locale: "es", pin_reset_sent_by: null });
    const audit = await owner.query<{ actor: string; changed_fields: string[] }>(
      `select actor, changed_fields from audit_log
        where venue_id = $1 and target = $2 and action = 'memberships.update'
        order by id desc limit 1`,
      [v.venueA, `memberships/${diego}`],
    );
    expect(audit.rows[0]?.actor).toBe(v.ownerA);
    expect(audit.rows[0]?.changed_fields).toContain("role");
    // Staff and the front desk both use 4 digits, so his PIN still works.
    expect(
      (await signed("/v1/auth/pin", { membership_id: diego, pin: "6358", client: "shared" }))
        .statusCode,
    ).toBe(200);
  });

  it("moving Diego to manager (6 digits) clears his PIN and sends a new link; he can't keep signing in with 6358", async () => {
    await owner.query("update users set email = 'diego@example.com' where name = 'Diego R.'");
    const r = await call(
      "PATCH",
      `/v1/venues/${v.venueA}/team/${diego}`,
      { role: "manager" },
      await stepUp(ownerCookie, ownerKey),
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(json(r)).toMatchObject({ role: "manager", pin_reset_sent_by: "email" });
    const row = await owner.query<{ pin_digits: number; pin_verifier: string | null }>(
      "select pin_digits, pin_verifier from memberships where id = $1",
      [diego],
    );
    expect(row.rows[0]).toEqual({ pin_digits: 6, pin_verifier: null });
    expect(
      (await signed("/v1/auth/pin", { membership_id: diego, pin: "6358", client: "shared" }))
        .statusCode,
    ).not.toBe(200);
  });

  it("turns training mode on and off for a person, with the passkey asked again (M7-03)", async () => {
    const on = await call(
      "PATCH",
      `/v1/venues/${v.venueA}/team/${diego}`,
      { training: true },
      await stepUp(ownerCookie, ownerKey),
    );
    expect(on.statusCode, on.body).toBe(200);
    expect(json(on)["training"]).toBe(true);
    const list = json(
      await call("GET", `/v1/venues/${v.venueA}/team`, undefined, { cookie: ownerCookie }),
    );
    const row = (list["people"] as { membership_id: string; training: boolean }[]).find(
      (p) => p.membership_id === diego,
    );
    expect(row?.training).toBe(true);
    // Without the passkey asked again, nothing changes.
    expect(
      (
        await call(
          "PATCH",
          `/v1/venues/${v.venueA}/team/${diego}`,
          { training: false },
          { cookie: ownerCookie },
        )
      ).statusCode,
    ).not.toBe(200);
    const off = await call(
      "PATCH",
      `/v1/venues/${v.venueA}/team/${diego}`,
      { training: false },
      await stepUp(ownerCookie, ownerKey),
    );
    expect(json(off)["training"]).toBe(false);
  });

  it("refuses an empty change, an unknown field, your own role, and a deactivated person", async () => {
    const headers = await stepUp(ownerCookie, ownerKey);
    expect(
      (await call("PATCH", `/v1/venues/${v.venueA}/team/${diego}`, {}, headers)).statusCode,
    ).toBe(400);
    expect(
      (
        await call(
          "PATCH",
          `/v1/venues/${v.venueA}/team/${diego}`,
          { tip_eligible: true },
          await stepUp(ownerCookie, ownerKey),
        )
      ).statusCode,
    ).toBe(400);
    const self = await call(
      "PATCH",
      `/v1/venues/${v.venueA}/team/${v.membershipA}`,
      { role: "manager" },
      await stepUp(ownerCookie, ownerKey),
    );
    expect(self.statusCode).toBe(400);
    expect(json(self).error?.message).toMatch(/own role/);
    const gone = await call(
      "POST",
      `/v1/venues/${v.venueA}/team/${andy}/deactivate`,
      {},
      await stepUp(ownerCookie, ownerKey),
    );
    expect(gone.statusCode, gone.body).toBe(200);
    expect(
      (
        await call(
          "PATCH",
          `/v1/venues/${v.venueA}/team/${andy}`,
          { locale: "es" },
          await stepUp(ownerCookie, ownerKey),
        )
      ).statusCode,
    ).toBe(404);
    const list = json(
      await call("GET", `/v1/venues/${v.venueA}/team`, undefined, { cookie: ownerCookie }),
    )["people"] as Array<Record<string, unknown>>;
    expect(list.find((p) => p["membership_id"] === andy)?.["status"]).toBe("deactivated");
  });
});
