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
import { SoftwarePasskey } from "./test-passkey.js";

/**
 * M1-20 acceptance: Abhishek's recovery code works once, and the same code
 * fails a second time; a recovery started at 10:41 PM on Fri Sep 25 completes
 * no earlier than 10:41 PM on Sun Sep 27, and Andy gets the notice at once.
 * Plus the second-owner path, cancelling, a fresh set of codes and the walls.
 */

const ORIGIN = "http://localhost:5173";
const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ABHISHEK_EMAIL = "abhishek@example.com";
const ANDY_EMAIL = "andy@example.com";
const PRIYA_EMAIL = "priya@example.com";
const OWNER_B_EMAIL = "owner-b@example.com";
const CODE_SHAPE = /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/;

/** The simulated clock keeps ticking in real time, so "at once" means within a few seconds. */
const within = (text: string, of: Temporal.Instant, seconds = 5) =>
  Math.abs(Temporal.Instant.from(text).epochMilliseconds - of.epochMilliseconds) < seconds * 1000;
const hoursBetween = (from: string, to: string) =>
  Temporal.Instant.from(to).since(Temporal.Instant.from(from)).total("hours");

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

interface NoticeJob {
  run_at: string;
  payload: {
    template: string;
    locale: string;
    data: { ownerName: string; method: string; requesterName?: string; readyAt: string };
  };
}

/** The recovery notices queued for an address, oldest first. */
async function notices(to: string): Promise<NoticeJob[]> {
  const r = await owner.query<NoticeJob>(
    `select run_at::text as run_at, payload from jobs
     where kind = 'email.send' and payload->>'template' = 'owner_recovery_notice' and payload->>'to' = $1
     order by created_at`,
    [to],
  );
  return r.rows;
}

async function enrolCodesSent(to: string): Promise<number> {
  const r = await owner.query<{ n: string }>(
    `select count(*)::text as n from jobs where kind = 'email.send' and payload->>'template' = 'sign_in_code' and payload->>'to' = $1`,
    [to],
  );
  return Number(r.rows[0]!.n);
}

async function emailedCode(to: string): Promise<string> {
  const r = await owner.query<{ payload: { data: { code: string } } }>(
    `select payload from jobs where kind = 'email.send' and payload->>'template' = 'sign_in_code' and payload->>'to' = $1 order by created_at desc limit 1`,
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

async function loginPasskey(email: string, passkey: SoftwarePasskey) {
  const start = json(await post("/v1/auth/login", { step: "start", method: "passkey", email }));
  const options = start["options"] as { challenge: string };
  const finish = await post("/v1/auth/login", {
    step: "finish",
    method: "passkey",
    email,
    credential: passkey.assert(options, ORIGIN),
    client: "web",
  });
  return { status: finish.statusCode, cookie: cookieOf(finish), body: json(finish) };
}

async function stepUp(cookie: string, passkey: SoftwarePasskey): Promise<string> {
  const start = json(await post("/v1/auth/step-up", { step: "start" }, { cookie }));
  const finish = json(
    await post(
      "/v1/auth/step-up",
      {
        step: "finish",
        credential: passkey.assert(start["options"] as { challenge: string }, ORIGIN),
      },
      { cookie },
    ),
  );
  return finish["step_up_token"] as string;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  owner = new pg.Pool({ connectionString: db.url, max: 2 });
  // Abhishek owns venue A; Priya owns both venues (a second owner of A); Andy manages A; owner B owns only B.
  await owner.query("update users set name = 'Abhishek G.', email = $2 where id = $1", [
    v.ownerA,
    ABHISHEK_EMAIL,
  ]);
  await owner.query("update users set name = 'Priya S.', email = $2 where id = $1", [
    v.ownerBoth,
    PRIYA_EMAIL,
  ]);
  await owner.query("update users set email = $2 where id = $1", [v.ownerB, OWNER_B_EMAIL]);
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
});

afterAll(async () => {
  await app.close();
  await owner.end();
  await db.drop();
});

let abhishekKey = new SoftwarePasskey("localhost");
const andyKey = new SoftwarePasskey("localhost");
const priyaKey = new SoftwarePasskey("localhost");
let abhishekCookie = "";
let andyCookie = "";
let priyaCookie = "";
let firstCodes: string[] = [];
let secondCodes: string[] = [];
let firstRecoveryId = "";

describe("ten recovery codes, shown once at enrollment", () => {
  it("an owner's first enrollment answers with ten codes; a manager's doesn't", async () => {
    const enrolled = await enrolPasskey(ABHISHEK_EMAIL, abhishekKey);
    abhishekCookie = enrolled.cookie;
    firstCodes = enrolled.body["recovery_codes"] as string[];
    expect(firstCodes).toHaveLength(10);
    for (const code of firstCodes) expect(code).toMatch(CODE_SHAPE);
    expect(new Set(firstCodes).size).toBe(10);
    const me = json(await get("/v1/auth/me", { cookie: abhishekCookie }));
    expect(me["recovery_codes_left"]).toBe(10);

    andyCookie = (await enrolPasskey(ANDY_EMAIL, andyKey)).cookie;
    const andyMe = json(await get("/v1/auth/me", { cookie: andyCookie }));
    expect(andyMe["recovery_codes_left"]).toBeNull();
    priyaCookie = (await enrolPasskey(PRIYA_EMAIL, priyaKey)).cookie;
  });

  it("the codes are stored hashed, never as typed", async () => {
    const rows = await owner.query<{ code_hash: string }>(
      "select code_hash from recovery_codes where user_id = $1",
      [v.ownerA],
    );
    expect(rows.rows).toHaveLength(10);
    for (const row of rows.rows) {
      expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(firstCodes).not.toContain(row.code_hash);
    }
  });
});

describe("Abhishek's recovery code works once", () => {
  it("starts a recovery that is ready 48 hours later, on the simulated clock", async () => {
    // Typed with the wrong case and no dash, as people do.
    const typed = firstCodes[0]!.toLowerCase().replace("-", "");
    const r = await post("/v1/auth/recover", { email: ABHISHEK_EMAIL, code: typed });
    expect(r.statusCode, r.body).toBe(202);
    const recovery = json(r)["recovery"] as Record<string, unknown>;
    firstRecoveryId = recovery["id"] as string;
    expect(recovery["method"]).toBe("recovery_code");
    // Fri Sep 25, 10:41 PM New York → ready Sun Sep 27, 10:41 PM New York, 48 real hours later.
    expect(within(recovery["requested_at"] as string, SEED_NOW)).toBe(true);
    // Two reads of the clock a millisecond apart: close to 48, not bit-exact.
    expect(
      hoursBetween(recovery["requested_at"] as string, recovery["ready_at"] as string),
    ).toBeCloseTo(48, 3);
    expect(
      within(recovery["ready_at"] as string, Temporal.Instant.from("2026-09-28T02:41:00Z")),
    ).toBe(true);
    expect(recovery["delay_hours"]).toBe(48);
    const me = json(await get("/v1/auth/me", { cookie: abhishekCookie }));
    expect(me["recovery_codes_left"]).toBe(9);
  });

  it("and the same code fails a second time; so does a wrong one or a manager's email", async () => {
    const again = await post("/v1/auth/recover", { email: ABHISHEK_EMAIL, code: firstCodes[0] });
    expect(again.statusCode).toBe(401);
    expect(json(again).error?.message).toBe("that recovery code didn't work");
    const wrong = await post("/v1/auth/recover", { email: ABHISHEK_EMAIL, code: "AAAAA-AAAAA" });
    expect(wrong.statusCode).toBe(401);
    const manager = await post("/v1/auth/recover", { email: ANDY_EMAIL, code: firstCodes[1] });
    expect(manager.statusCode).toBe(401);
    const unknown = await post("/v1/auth/recover", {
      email: "nobody@example.com",
      code: firstCodes[1],
    });
    expect(unknown.statusCode).toBe(401);
  });

  it("Andy gets the notice at once, in his language, naming when it completes", async () => {
    const toAndy = await notices(ANDY_EMAIL);
    expect(toAndy).toHaveLength(1);
    const job = toAndy[0]!;
    expect(within(job.run_at, SEED_NOW)).toBe(true);
    expect(job.payload.locale).toBe("en");
    expect(job.payload.data.ownerName).toBe("Abhishek G.");
    expect(job.payload.data.method).toBe("recovery_code");
    expect(job.payload.data.readyAt).toContain("Sunday, September 27, 2026");
    expect(job.payload.data.readyAt).toContain("10:41");
    // Every owner and manager of his venue hears, Abhishek included; the other venue's owner doesn't.
    expect(await notices(PRIYA_EMAIL)).toHaveLength(1);
    expect(await notices(ABHISHEK_EMAIL)).toHaveLength(1);
    expect(await notices(OWNER_B_EMAIL)).toHaveLength(0);
  });

  it("completes no earlier than 48 hours later: at 47h59m nothing opens", async () => {
    clock.advance(Temporal.Duration.from({ hours: 47, minutes: 59 }));
    const before = await enrolCodesSent(ABHISHEK_EMAIL);
    const start = await post("/v1/auth/enroll", { step: "start", email: ABHISHEK_EMAIL });
    expect(start.statusCode).toBe(200); // the same shape as always, but no code goes out
    expect(await enrolCodesSent(ABHISHEK_EMAIL)).toBe(before);
    const opts = await post("/v1/auth/enroll", {
      step: "passkey_options",
      email: ABHISHEK_EMAIL,
      code: "000000",
    });
    expect(opts.statusCode).toBe(401);
  });

  it("at 48 hours he enrols a new passkey; the old passkey, sessions and codes are gone", async () => {
    clock.advance(Temporal.Duration.from({ minutes: 1 }));
    const newKey = new SoftwarePasskey("localhost");
    const enrolled = await enrolPasskey(ABHISHEK_EMAIL, newKey);
    secondCodes = enrolled.body["recovery_codes"] as string[];
    expect(secondCodes).toHaveLength(10);
    expect(secondCodes).not.toEqual(firstCodes);

    expect((await loginPasskey(ABHISHEK_EMAIL, abhishekKey)).status).toBe(401);
    expect((await loginPasskey(ABHISHEK_EMAIL, newKey)).status).toBe(200);
    expect((await get("/v1/auth/me", { cookie: abhishekCookie })).statusCode).toBe(401);
    abhishekCookie = enrolled.cookie;
    const me = json(await get("/v1/auth/me", { cookie: abhishekCookie }));
    expect((me["credentials"] as unknown[]).length).toBe(1);
    expect(me["recovery_codes_left"]).toBe(10);

    const old = await post("/v1/auth/recover", { email: ABHISHEK_EMAIL, code: firstCodes[2] });
    expect(old.statusCode).toBe(401);
    const row = await owner.query<{ completed_at: string | null; cancelled_at: string | null }>(
      "select completed_at::text as completed_at, cancelled_at from owner_recoveries where id = $1",
      [firstRecoveryId],
    );
    expect(row.rows[0]!.completed_at).not.toBeNull();
    expect(row.rows[0]!.cancelled_at).toBeNull();
    abhishekKey = newKey;
  });
});

describe("through a second owner", () => {
  let recoveryId = "";

  it("a manager, or an owner of another venue, can't start it", async () => {
    // The clock moved 48 hours: everyone signs in again.
    andyCookie = (await loginPasskey(ANDY_EMAIL, andyKey)).cookie;
    const withoutStepUp = await post(
      "/v1/auth/recover/second-owner",
      { email: ABHISHEK_EMAIL },
      { cookie: andyCookie },
    );
    expect(withoutStepUp.statusCode).toBe(403);
    expect(json(withoutStepUp).error?.code).toBe("step_up_required");
    const andyTries = await post(
      "/v1/auth/recover/second-owner",
      { email: ABHISHEK_EMAIL },
      { cookie: andyCookie, "x-step-up": await stepUp(andyCookie, andyKey) },
    );
    expect(andyTries.statusCode).toBe(403);
    expect(json(andyTries).error?.message).toBe(
      "only a second owner of the same venue can start this",
    );

    const ownerBKey = new SoftwarePasskey("localhost");
    const ownerBCookie = (await enrolPasskey(OWNER_B_EMAIL, ownerBKey)).cookie;
    const ownerBTries = await post(
      "/v1/auth/recover/second-owner",
      { email: ABHISHEK_EMAIL },
      { cookie: ownerBCookie, "x-step-up": await stepUp(ownerBCookie, ownerBKey) },
    );
    expect(ownerBTries.statusCode).toBe(403);
    expect(await notices(ANDY_EMAIL)).toHaveLength(1);
  });

  it("Priya, an owner of the same venue, starts it with her passkey and a step-up; Andy hears at once", async () => {
    priyaCookie = (await loginPasskey(PRIYA_EMAIL, priyaKey)).cookie;
    const r = await post(
      "/v1/auth/recover/second-owner",
      { email: ABHISHEK_EMAIL },
      { cookie: priyaCookie, "x-step-up": await stepUp(priyaCookie, priyaKey) },
    );
    expect(r.statusCode, r.body).toBe(202);
    const recovery = json(r)["recovery"] as Record<string, unknown>;
    recoveryId = recovery["id"] as string;
    expect(recovery["method"]).toBe("second_owner");
    expect(within(recovery["ready_at"] as string, clock.now().add({ hours: 48 }))).toBe(true);
    const toAndy = await notices(ANDY_EMAIL);
    expect(toAndy).toHaveLength(2);
    expect(toAndy[1]!.payload.data.method).toBe("second_owner");
    expect(toAndy[1]!.payload.data.requesterName).toBe("Priya S.");

    // Starting it again answers the same recovery and sends nothing more.
    const again = await post(
      "/v1/auth/recover/second-owner",
      { email: ABHISHEK_EMAIL },
      { cookie: priyaCookie, "x-step-up": await stepUp(priyaCookie, priyaKey) },
    );
    expect(again.statusCode).toBe(202);
    expect((json(again)["recovery"] as Record<string, unknown>)["id"]).toBe(recoveryId);
    expect(await notices(ANDY_EMAIL)).toHaveLength(2);
  });

  it("only an owner of that venue can cancel it, and after that nothing opens at 48 hours", async () => {
    const andyCancels = await post(
      "/v1/auth/recover/cancel",
      { recovery_id: recoveryId },
      { cookie: andyCookie },
    );
    expect(andyCancels.statusCode).toBe(404);
    const cancelled = await post(
      "/v1/auth/recover/cancel",
      { recovery_id: recoveryId },
      { cookie: priyaCookie },
    );
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const twice = await post(
      "/v1/auth/recover/cancel",
      { recovery_id: recoveryId },
      { cookie: priyaCookie },
    );
    expect(twice.statusCode).toBe(409);

    clock.advance(Temporal.Duration.from({ hours: 48 }));
    const before = await enrolCodesSent(ABHISHEK_EMAIL);
    expect(
      (await post("/v1/auth/enroll", { step: "start", email: ABHISHEK_EMAIL })).statusCode,
    ).toBe(200);
    expect(await enrolCodesSent(ABHISHEK_EMAIL)).toBe(before);
  });

  it("the owner cancels a code-started recovery from their own passkey session", async () => {
    const started = json(
      await post("/v1/auth/recover", { email: ABHISHEK_EMAIL, code: secondCodes[0] }),
    )["recovery"] as Record<string, unknown>;
    abhishekCookie = (await loginPasskey(ABHISHEK_EMAIL, abhishekKey)).cookie;
    const cancelled = await post(
      "/v1/auth/recover/cancel",
      { recovery_id: started["id"] },
      { cookie: abhishekCookie },
    );
    expect(cancelled.statusCode, cancelled.body).toBe(200);
  });
});

describe("a fresh set of codes", () => {
  it("needs a passkey session with a step-up, retires the old set, and is for owners only", async () => {
    const without = await post("/v1/auth/recovery-codes", {}, { cookie: abhishekCookie });
    expect(without.statusCode).toBe(403);
    expect(json(without).error?.code).toBe("step_up_required");
    const fresh = await post(
      "/v1/auth/recovery-codes",
      {},
      { cookie: abhishekCookie, "x-step-up": await stepUp(abhishekCookie, abhishekKey) },
    );
    expect(fresh.statusCode, fresh.body).toBe(201);
    const codes = json(fresh)["recovery_codes"] as string[];
    expect(codes).toHaveLength(10);
    expect(json(await get("/v1/auth/me", { cookie: abhishekCookie }))["recovery_codes_left"]).toBe(
      10,
    );
    const old = await post("/v1/auth/recover", { email: ABHISHEK_EMAIL, code: secondCodes[1] });
    expect(old.statusCode).toBe(401);

    andyCookie = (await loginPasskey(ANDY_EMAIL, andyKey)).cookie;
    const andyAsks = await post(
      "/v1/auth/recovery-codes",
      {},
      { cookie: andyCookie, "x-step-up": await stepUp(andyCookie, andyKey) },
    );
    expect(andyAsks.statusCode).toBe(403);
    expect(json(andyAsks).error?.message).toBe("recovery codes are for owners");
  });
});

describe("the venue wall on the new tables", () => {
  it("as the app role, another person sees no codes or recoveries but their own and their co-owners'", async () => {
    const client = await owner.connect();
    try {
      await client.query("begin");
      await client.query("set local role app_rw");
      await client.query("select set_config('app.venue_id', $1, true)", [v.venueB]);
      await client.query("select set_config('app.user_id', $1, true)", [v.ownerB]);
      const codes = await client.query<{ user_id: string }>("select user_id from recovery_codes");
      expect(codes.rowCount).toBe(10); // owner B's own set from enrolling; everyone else's is hidden
      expect(codes.rows.every((row) => row.user_id === v.ownerB)).toBe(true);
      const recoveries = await client.query("select id from owner_recoveries");
      expect(recoveries.rowCount).toBe(0);
      await client.query("select set_config('app.user_id', $1, true)", [v.ownerBoth]);
      const asPriya = await client.query("select id from owner_recoveries");
      expect(asPriya.rowCount).toBeGreaterThan(0); // Priya co-owns venue A with Abhishek
      await client.query("rollback");
    } finally {
      client.release();
    }
  });
});
