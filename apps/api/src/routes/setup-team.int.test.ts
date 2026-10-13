import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import {
  encryptSecret,
  generateSigningKey,
  parseAuthSecretKey,
  publishRulePack,
  setPinVerifier,
} from "@west4/db";
import {
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, newYorkCounty } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { SoftwarePasskey } from "../auth/test-passkey.js";

/**
 * Set up your venue's step 9 (O-11; spec 17 · Step details 9; D115): the owner invites a manager
 * by phone (the link goes by text, the person confirms their phone and sets their own PIN); the
 * step is done once a manager has set a PIN and the first on-call and the breach contact are
 * named; only an active owner or manager can be named; deactivating the breach contact empties
 * the slot and the checklist needs attention; our platform rota (oncall_rota) is never touched.
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

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  owner = new pg.Pool({ connectionString: db.url, max: 2 });
  // Venue A's own Twilio account is connected (T-03; D123), so an invite by phone goes by text.
  await owner.query(
    `insert into integrations (venue_id, kind, status, external_id, config)
       values ($1, 'twilio', 'connected', $2, $3)`,
    [
      v.venueA,
      `AC${"8".repeat(32)}`,
      JSON.stringify({
        phone_e164: "+12125550998",
        secret_enc: encryptSecret(parseAuthSecretKey(KEY), "token"),
      }),
    ],
  );
  await publishRulePack(owner, {
    pack: newYorkCounty,
    effectiveOn: "2026-09-01",
    approvedBy: ["A", "B"],
    privateKeyPem: generateSigningKey().privateKeyPem,
  });
  await owner.query("update users set email = $2 where id = $1", [v.ownerA, OWNER_EMAIL]);
  clock = new SimulatedClock(SEED_NOW);
  const config = loadConfig({
    WEST4_ENV: "local",
    DATABASE_URL: db.url,
    // As the API runs: app_rw, row-level security on (an invite as the superuser hid a refusal).
    APP_DATABASE_URL: db.url.replace("//west4:west4@", "//app_rw:app_rw@"),
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

const A = () => `/v1/venues/${v.venueA}`;
const ownerGet = (url: string) =>
  app.inject({ method: "GET", url, headers: { cookie: ownerCookie } });
const ownerPut = (url: string, payload: unknown) =>
  app.inject({ method: "PUT", url, payload: payload as object, headers: { cookie: ownerCookie } });
const teamStep = async () =>
  (
    json(await ownerGet(`${A()}/setup`)) as unknown as {
      checklist: { steps: { id: string; mark: string; missing: string[] }[] };
    }
  ).checklist.steps.find((s) => s.id === "team")!;
const rota = async () =>
  (
    await owner.query(
      "select slot, console_staff_id, phone, updated_at, updated_by from oncall_rota order by slot",
    )
  ).rows;

describe("Step 9: team invites and the venue's on-call and breach contacts (O-11)", () => {
  const ANDY_PHONE = "+12125550188";
  let andy = "";
  let bea = "";
  let rotaBefore: unknown[] = [];

  it("invites a manager by phone: the link goes by text, nothing by email, and the invite opens", async () => {
    const staff = await owner.query<{ id: string }>(
      "insert into console_staff (name, email) values ('Ana', 'ana@ops.test') returning id",
    );
    await owner.query(
      "insert into oncall_rota (slot, console_staff_id, phone, updated_by) values ('first', $1, '+12125550100', 'test')",
      [staff.rows[0]!.id],
    );
    rotaBefore = await rota();
    const r = await post(
      `${A()}/team/invite`,
      { name: "Andy Park", phone_e164: ANDY_PHONE, role: "manager" },
      await stepUp(),
    );
    expect(r.statusCode, r.body).toBe(201);
    expect(json(r)["sent_by"]).toEqual(["text"]);
    andy = json(r)["membership_id"] as string;
    const text = await latestJob("text.send", ANDY_PHONE);
    expect(text["template"]).toBe("invite_link");
    const url = (text["data"] as { url: string }).url;
    expect(url).toContain("http://localhost:5173/invite/");
    const page = json(await get(`/v1/invites/${tokenOf(url)}`));
    expect(page).toMatchObject({
      state: "open",
      name: "Andy Park",
      role: "manager",
      pin_digits: 6,
    });
    const emailed = await owner.query(
      "select 1 from jobs where kind = 'email.send' and payload->'data'->>'inviteeName' = 'Andy Park'",
    );
    expect(emailed.rowCount).toBe(0);
    for (const bad of [
      { name: "No Way", role: "staff" },
      { name: "Bad Phone", phone_e164: "+1212555", role: "staff" },
    ]) {
      const refused = await post(`${A()}/team/invite`, bad, await stepUp());
      expect(refused.statusCode).toBe(400);
    }
  });

  it("isn't done until a manager has set a PIN and both contacts are named, and only leads can be named", async () => {
    expect((await teamStep()).missing).toEqual(["manager", "onCall", "breach"]);
    // Andy confirms his phone and sets his PIN on his own phone (M1-23's flow, tested there).
    await setPinVerifier(owner, v.venueA, andy, "$argon2id$test");
    const b = await post(
      `${A()}/team/invite`,
      { name: "Bea Cruz", email: "bea@example.com", role: "manager" },
      await stepUp(),
    );
    bea = json(b)["membership_id"] as string;
    await setPinVerifier(owner, v.venueA, bea, "$argon2id$test");
    const staffer = await post(
      `${A()}/team/invite`,
      { name: "Sol Diaz", phone_e164: "+12125550199", role: "bartender" },
      await stepUp(),
    );
    const sol = json(staffer)["membership_id"] as string;
    await setPinVerifier(owner, v.venueA, sol, "$argon2id$test");
    expect(await teamStep()).toMatchObject({ mark: "attention", missing: ["onCall", "breach"] });

    const contacts = (onCall: string, breach: string) => ({
      value: {
        bookingEmails: [],
        onCall: {
          first: { membershipId: onCall, days: [5, 6], from: "18:00", to: "04:00" },
          second: null,
        },
        breach: { primary: breach, backup: null },
      },
    });
    const refused = await ownerPut(`${A()}/settings/contacts`, contacts(andy, sol));
    expect(refused.statusCode, refused.body).toBe(400);
    const saved = await ownerPut(`${A()}/settings/contacts`, contacts(andy, bea));
    expect(saved.statusCode, saved.body).toBe(200);
    expect(await teamStep()).toMatchObject({ mark: "done", missing: [] });
  });

  it("deactivating the breach contact empties the slot, and the checklist needs attention", async () => {
    const r = await post(`${A()}/team/${bea}/deactivate`, {}, await stepUp());
    expect(r.statusCode, r.body).toBe(200);
    const value = (json(await ownerGet(`${A()}/settings/contacts`)) as { value: unknown }).value;
    expect(value).toMatchObject({
      onCall: { first: { membershipId: andy } },
      breach: { primary: null, backup: null },
    });
    expect(await teamStep()).toMatchObject({ mark: "attention", missing: ["breach"] });
    // Andy made a bartender: his on-call slot empties too.
    const patched = await app.inject({
      method: "PATCH",
      url: `${A()}/team/${andy}`,
      payload: { role: "bartender" },
      headers: await stepUp(),
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(
      (json(await ownerGet(`${A()}/settings/contacts`)) as { value: { onCall: unknown } }).value
        .onCall,
    ).toEqual({ first: null, second: null });
  });

  it("the venue wall: venue B's owner can't be named in venue A's contacts, nor read there", async () => {
    const ownerB = await owner.query<{ id: string }>(
      "select id from memberships where venue_id = $1 and user_id = $2",
      [v.venueB, v.ownerB],
    );
    const r = await ownerPut(`${A()}/settings/contacts`, {
      value: {
        bookingEmails: [],
        onCall: { first: null, second: null },
        breach: { primary: ownerB.rows[0]!.id, backup: null },
      },
    });
    expect(r.statusCode).toBe(400);
    expect((await ownerGet(`/v1/venues/${v.venueB}/settings/contacts`)).statusCode).toBe(403);
  });

  it("never touches our platform rota", async () => {
    expect(await rota()).toEqual(rotaBefore);
  });
});
