import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import {
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, Temporal } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { route } from "../http/conventions.js";
import { SoftwarePasskey } from "./test-passkey.js";
import { totpAt, stepAt } from "./totp.js";

/**
 * M1-19 acceptance: Andy (a manager) signs in with a passkey and opens Admin;
 * with the authenticator app instead, Admin is 403 and he can't decide an
 * approval; sessions lock after 30 idle minutes and end at 12 hours; a team
 * change inside a passkey session asks for the passkey again; and a PIN or
 * badge session never reaches Admin.
 */

const ORIGIN = "http://localhost:5173";
const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ANDY_EMAIL = "andy@example.com";
const OWNER_A_EMAIL = "owner-a@example.com";

let db: TestDatabase;
let v: TwoVenues;
let app: FastifyInstance;
let owner: pg.Pool;
let clock: SimulatedClock;
let andy: string;

const json = (r: { body: string }) =>
  JSON.parse(r.body) as Record<string, unknown> & { error?: { code: string; message: string } };
const cookieOf = (r: { headers: Record<string, unknown> }) => {
  const raw = r.headers["set-cookie"];
  const line = Array.isArray(raw) ? raw[0] : raw;
  return typeof line === "string" ? line.split(";")[0]! : "";
};
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, payload: body, headers });
const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "GET", url, headers });

/** The latest one-time code emailed to an address, read from the job the API queued. */
async function emailedCode(to: string): Promise<string> {
  const r = await owner.query<{ payload: { data: { code: string } } }>(
    `select payload from jobs where kind = 'email.send' and payload->>'to' = $1 order by created_at desc limit 1`,
    [to],
  );
  return r.rows[0]!.payload.data.code;
}

async function enrolPasskey(email: string, passkey: SoftwarePasskey) {
  expect((await post("/v1/auth/enroll", { step: "start", email })).statusCode).toBe(200);
  const code = await emailedCode(email);
  const opts = json(await post("/v1/auth/enroll", { step: "passkey_options", email, code }));
  const options = opts["options"] as { challenge: string };
  const finish = await post("/v1/auth/enroll", {
    step: "passkey_finish",
    email,
    code,
    credential: passkey.register(options, ORIGIN),
    name: "Test phone",
    client: "web",
  });
  expect(finish.statusCode, finish.body).toBe(201);
  return { cookie: cookieOf(finish), body: json(finish) };
}

async function loginPasskey(
  email: string,
  passkey: SoftwarePasskey,
  client: "web" | "desktop" = "web",
) {
  const start = json(await post("/v1/auth/login", { step: "start", method: "passkey", email }));
  const options = start["options"] as { challenge: string };
  const finish = await post("/v1/auth/login", {
    step: "finish",
    method: "passkey",
    email,
    credential: passkey.assert(options, ORIGIN),
    client,
  });
  return { status: finish.statusCode, cookie: cookieOf(finish), body: json(finish) };
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  owner = new pg.Pool({ connectionString: db.url, max: 2 });
  // Andy: a manager at venue A with an email; Owner A stays the venue's owner.
  andy = (
    await owner.query<{ id: string }>(
      "insert into users (name, email) values ('Andy C.', $1) returning id",
      [ANDY_EMAIL],
    )
  ).rows[0]!.id;
  await owner.query(
    "insert into memberships (venue_id, user_id, role, status) values ($1, $2, 'manager', 'active')",
    [v.venueA, andy],
  );
  await owner.query("update users set email = $2 where id = $1", [v.ownerA, OWNER_A_EMAIL]);
  clock = new SimulatedClock(SEED_NOW);
  const config = loadConfig({
    WEST4_ENV: "local",
    DATABASE_URL: db.url,
    APP_DATABASE_URL: db.url,
    AUTH_SECRET_KEY: KEY,
    WEBAUTHN_RP_ID: "localhost",
    WEBAUTHN_ORIGINS: ORIGIN,
  });
  app = buildApp({
    config,
    clock,
    moduleCacheMs: 0,
    authenticators: [
      async (request) => {
        const raw = request.headers["x-test-principal"];
        return typeof raw === "string" ? JSON.parse(raw) : undefined;
      },
    ],
    extraRoutes: (a) => {
      // Stand-ins for Admin → Team (M1-31) and deciding an approval (M2): the registry flags do the work.
      a.patch(
        "/v1/venues/:venueId/fixture/team",
        {
          config: route({
            principals: ["owner_manager"],
            module: "core",
            action: "admin.team",
            stepUp: true,
            idempotency: "none",
          }),
        },
        async () => ({ changed: true }),
      );
      a.post(
        "/v1/venues/:venueId/fixture/decide",
        {
          config: route({
            principals: ["owner_manager"],
            module: "core",
            action: "approvals.decide",
            idempotency: "none",
          }),
        },
        async () => ({ decided: true }),
      );
    },
  });
  await app.ready();
  await owner.query("set role app_rw"); // the seed of the two venues is done; from here the owner pool reads like the app
  await owner.query("reset role");
});

afterAll(async () => {
  await app.close();
  await owner.end();
  await db.drop();
});

describe("two-step sign-in can't be turned off", () => {
  it("every owner and manager has mfa_required, set by the membership trigger", async () => {
    const r = await owner.query<{ mfa_required: boolean }>(
      "select mfa_required from users where id = $1",
      [andy],
    );
    expect(r.rows[0]!.mfa_required).toBe(true);
    const bartender = await owner.query<{ mfa_required: boolean }>(
      "select mfa_required from users where id = $1",
      [v.bartenderA],
    );
    expect(bartender.rows[0]!.mfa_required).toBe(false);
  });
});

describe("Andy signs in with a passkey and opens Admin", () => {
  const passkey = new SoftwarePasskey("localhost");
  let cookie = "";

  it("enrols his first passkey after a code from his email, and is signed in", async () => {
    const r = await enrolPasskey(ANDY_EMAIL, passkey);
    cookie = r.cookie;
    expect(cookie).toMatch(/^west4_session=/);
    expect((r.body["session"] as { assurance: string }).assurance).toBe("passkey");
    const me = json(await get("/v1/auth/me", { cookie }));
    expect((me["session"] as { assurance: string }).assurance).toBe("passkey");
    expect(me["memberships"]).toEqual([
      expect.objectContaining({ venue_id: v.venueA, role: "manager" }),
    ]);
  });

  it("signs in again with the passkey on the web (cookie) and in the desktop app (bearer token)", async () => {
    const web = await loginPasskey(ANDY_EMAIL, passkey, "web");
    expect(web.status, JSON.stringify(web.body)).toBe(200);
    expect(web.cookie).toMatch(/^west4_session=/);
    expect(web.body["token"]).toBeUndefined();
    const desktop = await loginPasskey(ANDY_EMAIL, passkey, "desktop");
    expect(desktop.status).toBe(200);
    expect(desktop.cookie).toBe("");
    const token = desktop.body["token"] as string;
    const me = json(await get("/v1/auth/me", { authorization: `Bearer ${token}` }));
    expect((me["user"] as { id: string }).id).toBe(andy);
    cookie = web.cookie;
  });

  it("opens Admin (an admin.access route) in the passkey session", async () => {
    const r = await get(`/v1/venues/${v.venueA}/devices`, { cookie });
    expect(r.statusCode, r.body).toBe(200);
  });

  it("refuses a replayed assertion, a wrong origin and a stale counter", async () => {
    const start = json(
      await post("/v1/auth/login", { step: "start", method: "passkey", email: ANDY_EMAIL }),
    );
    const options = start["options"] as { challenge: string };
    const assertion = passkey.assert(options, ORIGIN);
    const first = await post("/v1/auth/login", {
      step: "finish",
      method: "passkey",
      email: ANDY_EMAIL,
      credential: assertion,
      client: "web",
    });
    expect(first.statusCode).toBe(200);
    const replay = await post("/v1/auth/login", {
      step: "finish",
      method: "passkey",
      email: ANDY_EMAIL,
      credential: assertion,
      client: "web",
    });
    expect(replay.statusCode).toBe(401);
    const start2 = json(
      await post("/v1/auth/login", { step: "start", method: "passkey", email: ANDY_EMAIL }),
    );
    const wrongOrigin = await post("/v1/auth/login", {
      step: "finish",
      method: "passkey",
      email: ANDY_EMAIL,
      credential: passkey.assert(
        start2["options"] as { challenge: string },
        "https://evil.example",
      ),
      client: "web",
    });
    expect(wrongOrigin.statusCode).toBe(401);
    // A cloned key would present an old counter.
    const start3 = json(
      await post("/v1/auth/login", { step: "start", method: "passkey", email: ANDY_EMAIL }),
    );
    passkey.counter = 0;
    const stale = await post("/v1/auth/login", {
      step: "finish",
      method: "passkey",
      email: ANDY_EMAIL,
      credential: passkey.assert(start3["options"] as { challenge: string }, ORIGIN),
      client: "web",
    });
    expect(stale.statusCode).toBe(401);
    passkey.counter = 10;
  });

  it("an unknown email gets the same shape of answer and no session", async () => {
    const start = await post("/v1/auth/login", {
      step: "start",
      method: "passkey",
      email: "nobody@example.com",
    });
    expect(start.statusCode).toBe(200);
    expect(json(start)["options"]).toEqual(
      expect.objectContaining({ challenge: expect.any(String) }),
    );
    const other = new SoftwarePasskey("localhost");
    const finish = await post("/v1/auth/login", {
      step: "finish",
      method: "passkey",
      email: "nobody@example.com",
      credential: other.assert(json(start)["options"] as { challenge: string }, ORIGIN),
      client: "web",
    });
    expect(finish.statusCode).toBe(401);
  });

  it("a team change inside a passkey session asks for the passkey again", async () => {
    // Andy is a manager: team changes are the owner's, so his role is refused before any step-up.
    const manager = await app.inject({
      method: "PATCH",
      url: `/v1/venues/${v.venueA}/fixture/team`,
      headers: { cookie },
      payload: {},
    });
    expect(manager.statusCode).toBe(403);
    expect(json(manager).error?.message).toBe("your role can't do this");

    const ownerKey = new SoftwarePasskey("localhost");
    const ownerCookie = (await enrolPasskey(OWNER_A_EMAIL, ownerKey)).cookie;
    const without = await app.inject({
      method: "PATCH",
      url: `/v1/venues/${v.venueA}/fixture/team`,
      headers: { cookie: ownerCookie },
      payload: {},
    });
    expect(without.statusCode, without.body).toBe(403);
    expect(json(without).error?.code).toBe("step_up_required");

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
    const stepUp = finish["step_up_token"] as string;
    expect(stepUp).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    const withToken = await app.inject({
      method: "PATCH",
      url: `/v1/venues/${v.venueA}/fixture/team`,
      headers: { cookie: ownerCookie, "x-step-up": stepUp },
      payload: {},
    });
    expect(withToken.statusCode, withToken.body).toBe(200);
    // The token works once.
    const again = await app.inject({
      method: "PATCH",
      url: `/v1/venues/${v.venueA}/fixture/team`,
      headers: { cookie: ownerCookie, "x-step-up": stepUp },
      payload: {},
    });
    expect(again.statusCode).toBe(403);
    expect(json(again).error?.code).toBe("step_up_required");
  });

  it("adding another passkey needs the step-up; a wrong step-up token is refused", async () => {
    const refused = await post(
      "/v1/auth/enroll",
      { step: "passkey_options" },
      { cookie, "x-step-up": "not-a-token" },
    );
    expect(refused.statusCode, refused.body).toBe(403);
    expect(json(refused).error?.code, refused.body).toBe("step_up_required");
  });

  it("signs out: the cookie is cleared and the session is over", async () => {
    const out = await post("/v1/auth/logout", {}, { cookie });
    expect(out.statusCode).toBe(200);
    expect(cookieOf(out)).toBe("west4_session=");
    const me = await get("/v1/auth/me", { cookie });
    expect(me.statusCode).toBe(401);
    expect(json(me).error?.code).toBe("session_expired");
  });
});

describe("Signed in with the authenticator app instead", () => {
  let cookie = "";
  let secret = "";
  const passkey = new SoftwarePasskey("localhost");

  it("enrols the authenticator app from a passkey session with a step-up, and the first code confirms it", async () => {
    const signedIn = await loginPasskey(ANDY_EMAIL, passkey, "web").then(async (r) => {
      // Andy's earlier passkey is the one enrolled above; this new one needs a fresh enrolment first.
      if (r.status === 200) return r;
      return r;
    });
    expect(signedIn.status).toBe(401); // a passkey the server never saw
    // Use the passkey Andy enrolled in the first block: sign in with it through a step-up.
    const first = await owner.query<{ credential_id: string }>(
      "select credential_id from auth_credentials where user_id = $1 and kind = 'passkey' and revoked_at is null",
      [andy],
    );
    expect(first.rows).toHaveLength(1);
  });

  it("enrols an authenticator on a fresh account after the emailed code, and signs in with email code + app code", async () => {
    const email = "owner-b@example.com";
    await owner.query("update users set email = $2 where id = $1", [v.ownerB, email]);
    expect((await post("/v1/auth/enroll", { step: "start", email })).statusCode).toBe(200);
    const code = await emailedCode(email);
    const started = json(
      await post("/v1/auth/enroll", { step: "authenticator_start", email, code }),
    );
    secret = started["secret"] as string;
    expect(started["otpauth_url"]).toMatch(
      /^otpauth:\/\/totp\/West%204%20staff%20app:owner-b%40example.com\?secret=/,
    );
    const nowMs = clock.now().epochMilliseconds;
    const wrong = await post("/v1/auth/enroll", {
      step: "authenticator_finish",
      email,
      code,
      totp_code: "000000",
      client: "web",
    });
    expect(wrong.statusCode).toBe(401);
    const finish = await post("/v1/auth/enroll", {
      step: "authenticator_finish",
      email,
      code,
      totp_code: totpAt(secret, stepAt(nowMs)),
      client: "web",
    });
    expect(finish.statusCode, finish.body).toBe(201);
    expect((json(finish)["session"] as { assurance: string }).assurance).toBe("authenticator");

    // Sign in again: email code, then the app's code (the next step, since the first was used up).
    clock.advance(Temporal.Duration.from({ minutes: 1 }));
    const start = await post("/v1/auth/login", { step: "start", method: "authenticator", email });
    expect(json(start)).toEqual(
      expect.objectContaining({ method: "authenticator", code_sent: true }),
    );
    const emailCode = await emailedCode(email);
    const totp = totpAt(secret, stepAt(clock.now().epochMilliseconds));
    const login = await post("/v1/auth/login", {
      step: "finish",
      method: "authenticator",
      email,
      email_code: emailCode,
      totp_code: totp,
      client: "web",
    });
    expect(login.statusCode, login.body).toBe(200);
    cookie = cookieOf(login);
    expect((json(login)["session"] as { assurance: string }).assurance).toBe("authenticator");

    // The same app code never works twice.
    const startAgain = await post("/v1/auth/login", {
      step: "start",
      method: "authenticator",
      email,
    });
    expect(startAgain.statusCode).toBe(200);
    const replay = await post("/v1/auth/login", {
      step: "finish",
      method: "authenticator",
      email,
      email_code: await emailedCode(email),
      totp_code: totp,
      client: "web",
    });
    expect(replay.statusCode).toBe(401);
  });

  it('Admin answers 403 forbidden ("Admin needs a passkey")', async () => {
    const r = await get(`/v1/venues/${v.venueB}/devices`, { cookie });
    expect(r.statusCode).toBe(403);
    expect(json(r).error).toEqual(
      expect.objectContaining({ code: "forbidden", message: "Admin needs a passkey" }),
    );
  });

  it("and he can't decide an approval", async () => {
    const r = await post(`/v1/venues/${v.venueB}/fixture/decide`, {}, { cookie });
    expect(r.statusCode).toBe(403);
    expect(json(r).error?.message).toBe("Approving needs a passkey");
  });

  it("but the rest of an owner's routes still open", async () => {
    const r = await get("/v1/auth/me", { cookie });
    expect(r.statusCode).toBe(200);
    expect((json(r)["session"] as { assurance: string }).assurance).toBe("authenticator");
  });

  it("can add its first passkey from the authenticator session, without a step-up", async () => {
    const opts = await post("/v1/auth/enroll", { step: "passkey_options" }, { cookie });
    expect(opts.statusCode, opts.body).toBe(200);
    const pk = new SoftwarePasskey("localhost");
    const finish = await post(
      "/v1/auth/enroll",
      {
        step: "passkey_finish",
        credential: pk.register(json(opts)["options"] as { challenge: string }, ORIGIN),
        name: "Laptop",
      },
      { cookie },
    );
    expect(finish.statusCode, finish.body).toBe(201);
    expect(json(finish)["session"]).toBeUndefined(); // already signed in; the session stays an authenticator one
    const second = await post("/v1/auth/enroll", { step: "passkey_options" }, { cookie });
    expect(second.statusCode).toBe(403); // a second passkey needs the passkey
  });
});

describe("sessions on the simulated clock", () => {
  const passkey = new SoftwarePasskey("localhost");
  const email = "owner-both@example.com";

  beforeAll(async () => {
    await owner.query("update users set email = $2 where id = $1", [v.ownerBoth, email]);
    await enrolPasskey(email, passkey);
  });

  it("a session idle for 30 minutes locks", async () => {
    const { cookie } = await loginPasskey(email, passkey);
    clock.advance(Temporal.Duration.from({ minutes: 29 }));
    expect((await get("/v1/auth/me", { cookie })).statusCode).toBe(200);
    clock.advance(Temporal.Duration.from({ minutes: 29 })); // 29 minutes since that request: still fine
    expect((await get("/v1/auth/me", { cookie })).statusCode).toBe(200);
    clock.advance(Temporal.Duration.from({ minutes: 30 }));
    const locked = await get("/v1/auth/me", { cookie });
    expect(locked.statusCode).toBe(401);
    expect(json(locked).error?.code).toBe("session_locked");
    const row = await owner.query<{ end_reason: string }>(
      "select end_reason from auth_sessions where user_id = $1 order by started_at desc limit 1",
      [v.ownerBoth],
    );
    expect(row.rows[0]!.end_reason).toBe("idle");
  });

  it("every session ends at 12 hours, however busy", async () => {
    const { cookie } = await loginPasskey(email, passkey);
    for (let i = 0; i < 47; i++) {
      clock.advance(Temporal.Duration.from({ minutes: 15 }));
      expect((await get("/v1/auth/me", { cookie })).statusCode).toBe(200);
    }
    clock.advance(Temporal.Duration.from({ minutes: 15 })); // 12 hours exactly
    const over = await get("/v1/auth/me", { cookie });
    expect(over.statusCode).toBe(401);
    expect(json(over).error?.code).toBe("session_expired");
  });

  it("a locked cookie doesn't stop signing in again", async () => {
    const { cookie } = await loginPasskey(email, passkey);
    clock.advance(Temporal.Duration.from({ minutes: 31 }));
    const start = await post(
      "/v1/auth/login",
      { step: "start", method: "passkey", email },
      { cookie },
    );
    expect(start.statusCode).toBe(200);
  });
});

describe("Every Admin route called with a PIN session or a badge session answers 403", () => {
  const principal = (session: "pin" | "badge") =>
    JSON.stringify({
      kind: "user",
      userId: v.ownerA,
      session,
      memberships: [{ venueId: v.venueA, membershipId: v.membershipA, role: "owner" }],
    });

  it("even for an owner, on every admin.* and passkey-only route in the registry", async () => {
    const adminRoutes = app.routes.filter(
      (r) => r.assurance === "passkey" || (r.action?.startsWith("admin.") ?? false),
    );
    expect(adminRoutes.length).toBeGreaterThan(3);
    for (const session of ["pin", "badge"] as const) {
      for (const r of adminRoutes) {
        const url = r.url
          .replace(":venueId", v.venueA)
          .replace(/:\w+/g, "00000000-0000-0000-0000-000000000001");
        const res = await app.inject({
          method: r.method as "GET",
          url,
          headers: { "x-test-principal": principal(session) },
          ...(r.method === "GET" ? {} : { payload: {} }),
        });
        expect(res.statusCode, `${session} ${r.method} ${r.url}`).toBe(403);
      }
    }
  });
});
