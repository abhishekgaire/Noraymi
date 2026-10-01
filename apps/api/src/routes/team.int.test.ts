import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { parseAuthSecretKey, verifyPin } from "@west4/db";
import {
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, makeDeviceKey } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { SoftwarePasskey } from "../auth/test-passkey.js";

/**
 * M1-23 acceptance: Diego's invite opens on his phone, confirms his number
 * with a texted code, refuses 1234, 1111, 0000 and 2580 and accepts a 4-digit
 * PIN of his own; Andy's needs 6 digits. The database holds only Argon2id
 * verifiers, and the same PIN gives Maya and Diego different ones. A reset
 * sends a new link to the phone and the old PIN stops at once. No email or
 * text carries a PIN.
 */
const ORIGIN = "http://localhost:5173";
const KEY = "a".repeat(64);
const OWNER_EMAIL = "owner-a@example.com";

let db: TestDatabase;
let v: TwoVenues;
let app: FastifyInstance;
let owner: pg.Pool;
let clock: SimulatedClock;
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
const get = (url: string) => app.inject({ method: "GET", url });

async function latestJob(kind: string, to: string): Promise<Record<string, unknown>> {
  const r = await owner.query<{ payload: Record<string, unknown> }>(
    "select payload from jobs where kind = $1 and payload->>'to' = $2 order by created_at desc limit 1",
    [kind, to],
  );
  return r.rows[0]!.payload;
}

const tokenOf = (url: string) => url.split("/invite/")[1]!;

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

async function invite(name: string, email: string, role: string) {
  const r = await post(`/v1/venues/${v.venueA}/team/invite`, { name, email, role }, await stepUp());
  expect(r.statusCode, r.body).toBe(201);
  const mail = await latestJob("email.send", email);
  const data = mail["data"] as { inviteUrl: string };
  expect(data.inviteUrl).toContain("http://localhost:5173/invite/");
  return { membershipId: json(r)["membership_id"] as string, token: tokenOf(data.inviteUrl) };
}

async function confirmPhone(token: string, phone: string) {
  const sent = await post(`/v1/invites/${token}/phone`, { phone_e164: phone });
  expect(sent.statusCode, sent.body).toBe(200);
  const text = await latestJob("text.send", phone);
  const code = (text["data"] as { code: string }).code;
  expect(code).toMatch(/^\d{6}$/);
  const ok = await post(`/v1/invites/${token}/phone/verify`, { phone_e164: phone, code });
  expect(ok.statusCode, ok.body).toBe(200);
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  owner = new pg.Pool({ connectionString: db.url, max: 2 });
  await owner.query("update users set email = $2 where id = $1", [v.ownerA, OWNER_EMAIL]);
  clock = new SimulatedClock(SEED_NOW);
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
  // The owner's first passkey, through the emailed code, then a passkey session.
  expect((await post("/v1/auth/enroll", { step: "start", email: OWNER_EMAIL })).statusCode).toBe(
    200,
  );
  const code = (await latestJob("email.send", OWNER_EMAIL))["data"] as { code: string };
  const opts = json(
    await post("/v1/auth/enroll", { step: "passkey_options", email: OWNER_EMAIL, code: code.code }),
  );
  const finish = await post("/v1/auth/enroll", {
    step: "passkey_finish",
    email: OWNER_EMAIL,
    code: code.code,
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

describe("invites, phone codes and PINs", () => {
  let diego = { membershipId: "", token: "" };
  const DIEGO_PHONE = "+12125550123";

  it("the owner invites Diego: a 4-digit membership and an emailed link; without the passkey step-up it's refused", async () => {
    const without = await post(
      `/v1/venues/${v.venueA}/team/invite`,
      { name: "Diego R.", email: "diego@example.com", role: "front_desk" },
      { cookie: ownerCookie },
    );
    expect(without.statusCode).toBe(403);
    expect(json(without).error?.code).toBe("step_up_required");
    diego = await invite("Diego R.", "diego@example.com", "front_desk");
    const page = json(await get(`/v1/invites/${diego.token}`));
    expect(page).toMatchObject({
      state: "open",
      name: "Diego R.",
      role: "front_desk",
      pin_digits: 4,
      phone_verified: false,
      needs_passkey: false,
    });
    expect((await get("/v1/invites/not-a-token")).statusCode).toBe(404);
  });

  it("confirms his number with a texted code: a wrong code fails, and the PIN step waits for it", async () => {
    const early = await post(`/v1/invites/${diego.token}/finish`, { pin: "6358", locale: "en" });
    expect(early.statusCode).toBe(403);
    const sent = await post(`/v1/invites/${diego.token}/phone`, { phone_e164: DIEGO_PHONE });
    expect(sent.statusCode, sent.body).toBe(200);
    const wrong = await post(`/v1/invites/${diego.token}/phone/verify`, {
      phone_e164: DIEGO_PHONE,
      code: "000000",
    });
    expect(wrong.statusCode).toBe(400);
    const text = await latestJob("text.send", DIEGO_PHONE);
    expect(text["template"]).toBe("phone_code");
    const code = (text["data"] as { code: string }).code;
    const ok = await post(`/v1/invites/${diego.token}/phone/verify`, {
      phone_e164: DIEGO_PHONE,
      code,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const user = await owner.query<{ phone_e164: string; verified: boolean }>(
      "select phone_e164, phone_verified_at is not null as verified from users where id = (select user_id from memberships where id = $1)",
      [diego.membershipId],
    );
    expect(user.rows[0]).toEqual({ phone_e164: DIEGO_PHONE, verified: true });
  });

  it("refuses 1234, 1111, 0000 and 2580, accepts 6358, and his phone becomes his staff_phone", async () => {
    for (const [pin, reason] of [
      ["1234", "sequential"],
      ["1111", "repeated"],
      ["0000", "repeated"],
      ["2580", "common"],
      ["635", "length"],
    ]) {
      const r = await post(`/v1/invites/${diego.token}/finish`, { pin, locale: "es" });
      expect(r.statusCode, pin).toBe(400);
      expect(json(r).error?.message).toBe(`pin: ${reason}`);
    }
    const key = await makeDeviceKey();
    const done = await post(`/v1/invites/${diego.token}/finish`, {
      pin: "6358",
      locale: "es",
      phone_name: "iPhone",
      public_key: key.publicJwk,
    });
    expect(done.statusCode, done.body).toBe(200);
    expect(json(done)["enrol_code"]).toBeNull();
    const deviceId = json(done)["device_id"] as string;
    const m = await owner.query<{ status: string; locale: string; pin_verifier: string }>(
      "select status, locale, pin_verifier from memberships where id = $1",
      [diego.membershipId],
    );
    expect(m.rows[0]).toMatchObject({ status: "active", locale: "es" });
    expect(m.rows[0]!.pin_verifier).toMatch(/^\$argon2id\$/);
    expect(
      await verifyPin(
        parseAuthSecretKey(KEY),
        m.rows[0]!.pin_verifier,
        v.venueA,
        diego.membershipId,
        "6358",
      ),
    ).toBe(true);
    const device = await owner.query<{ kind: string; user_id: string }>(
      "select kind, user_id from devices where id = $1",
      [deviceId],
    );
    expect(device.rows[0]!.kind).toBe("staff_phone");
    expect(json(await get(`/v1/invites/${diego.token}`))["state"]).toBe("used");
    expect(
      (await post(`/v1/invites/${diego.token}/finish`, { pin: "6358", locale: "en" })).statusCode,
    ).toBe(403);
  });

  it("Andy's invite needs 6 digits and hands him a one-time code to enrol a passkey", async () => {
    const andy = await invite("Andy C.", "andy-new@example.com", "manager");
    expect(json(await get(`/v1/invites/${andy.token}`))).toMatchObject({
      pin_digits: 6,
      needs_passkey: true,
    });
    await confirmPhone(andy.token, "+12125550124");
    const short = await post(`/v1/invites/${andy.token}/finish`, { pin: "4071", locale: "en" });
    expect(short.statusCode).toBe(400);
    expect(json(short).error?.message).toBe("pin: length");
    const done = json(
      await post(`/v1/invites/${andy.token}/finish`, { pin: "730915", locale: "en" }),
    );
    const enrolCode = done["enrol_code"] as string;
    expect(enrolCode).toMatch(/^\d{6}$/);
    const opts = await post("/v1/auth/enroll", {
      step: "passkey_options",
      email: "andy-new@example.com",
      code: enrolCode,
    });
    expect(opts.statusCode, opts.body).toBe(200);
    expect((json(opts)["options"] as { challenge: string }).challenge).toBeTruthy();
  });

  it("the same PIN gives Maya and Diego two different verifiers", async () => {
    const maya = await invite("Maya S.", "maya@example.com", "bartender");
    await confirmPhone(maya.token, "+12125550125");
    expect(
      (await post(`/v1/invites/${maya.token}/finish`, { pin: "6358", locale: "en" })).statusCode,
    ).toBe(200);
    const rows = await owner.query<{ pin_verifier: string }>(
      "select pin_verifier from memberships where id = any($1)",
      [[maya.membershipId, diego.membershipId]],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]!.pin_verifier).not.toBe(rows.rows[1]!.pin_verifier);
  });

  it("a reset texts Diego a new link and his old PIN stops at once; the new link skips the phone step", async () => {
    const r = await post(
      `/v1/venues/${v.venueA}/team/${diego.membershipId}/reset-pin`,
      {},
      await stepUp(),
    );
    expect(r.statusCode, r.body).toBe(202);
    expect(json(r)["sent_by"]).toBe("text");
    const m = await owner.query<{ pin_verifier: string | null }>(
      "select pin_verifier from memberships where id = $1",
      [diego.membershipId],
    );
    expect(m.rows[0]!.pin_verifier).toBeNull();
    const text = await latestJob("text.send", DIEGO_PHONE);
    expect(text["template"]).toBe("pin_reset_link");
    const token = tokenOf((text["data"] as { url: string }).url);
    expect(json(await get(`/v1/invites/${token}`))).toMatchObject({
      state: "open",
      phone_verified: true,
    });
    const done = await post(`/v1/invites/${token}/finish`, { pin: "9316", locale: "es" });
    expect(done.statusCode, done.body).toBe(200);
    const after = await owner.query<{ pin_verifier: string }>(
      "select pin_verifier from memberships where id = $1",
      [diego.membershipId],
    );
    expect(
      await verifyPin(
        parseAuthSecretKey(KEY),
        after.rows[0]!.pin_verifier,
        v.venueA,
        diego.membershipId,
        "9316",
      ),
    ).toBe(true);
  });

  it("a link expires on the simulated clock, and no email or text ever carried a PIN", async () => {
    const late = await invite("Late L.", "late@example.com", "staff");
    clock.advance({ hours: 49 });
    expect(json(await get(`/v1/invites/${late.token}`))["state"]).toBe("expired");
    expect(
      (await post(`/v1/invites/${late.token}/phone`, { phone_e164: "+12125550126" })).statusCode,
    ).toBe(403);
    const jobs = await owner.query<{ payload: unknown }>(
      "select payload from jobs where kind in ('email.send', 'text.send')",
    );
    for (const job of jobs.rows) {
      const text = JSON.stringify(job.payload);
      for (const pin of ["6358", "730915", "9316"]) expect(text, text).not.toContain(pin);
    }
  });
});
