import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { generateSigningKey, publishRulePack } from "@west4/db";
import {
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, builtInRulePacks } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { SoftwarePasskey } from "../auth/test-passkey.js";

/**
 * M1-36: Admin reads what a published rule-pack version changes and from
 * which business date, before it applies. On business date Fri Sep 25 the
 * venue runs 2026.09; a 2026.10 effective Sat Sep 26 is "next".
 */
const ORIGIN = "http://localhost:5173";
const KEY = "b".repeat(64);
const OWNER_EMAIL = "owner-a@example.com";
let db: TestDatabase;
let v: TwoVenues;
let app: FastifyInstance;
let owner: pg.Pool;
const ownerKey = new SoftwarePasskey("localhost");
let cookie = "";
const json = (r: { body: string }) => JSON.parse(r.body) as Record<string, unknown>;
const cookieOf = (r: { headers: Record<string, unknown> }) => {
  const raw = r.headers["set-cookie"];
  const line = Array.isArray(raw) ? raw[0] : raw;
  return typeof line === "string" ? line.split(";")[0]! : "";
};
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, payload: body as Record<string, unknown>, headers });

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
  app = buildApp({ config, clock: new SimulatedClock(SEED_NOW), moduleCacheMs: 0 });
  await app.ready();
  const key = generateSigningKey().privateKeyPem;
  const base = builtInRulePacks[0]!;
  await publishRulePack(owner, {
    pack: base,
    effectiveOn: "2026-09-01",
    approvedBy: ["A", "B"],
    privateKeyPem: key,
  });
  await publishRulePack(owner, {
    pack: { ...base, version: "2026.10", alcohol: { ...base.alcohol, lastSale: "03:00" } },
    effectiveOn: "2026-09-26",
    approvedBy: ["A", "B"],
    privateKeyPem: key,
  });
  expect((await post("/v1/auth/enroll", { step: "start", email: OWNER_EMAIL })).statusCode).toBe(
    200,
  );
  const code = (
    await owner.query<{ payload: { data: { code: string } } }>(
      "select payload from jobs where kind = 'email.send' and payload->>'to' = $1 order by created_at desc limit 1",
      [OWNER_EMAIL],
    )
  ).rows[0]!.payload.data.code;
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
  cookie = cookieOf(finish);
});

afterAll(async () => {
  await app.close();
  await owner.end();
  await db.drop();
});

describe("GET /rule-pack", () => {
  it("names tonight's version and the next one with what changes and when", async () => {
    const r = await app.inject({
      method: "GET",
      url: `/v1/venues/${v.venueA}/rule-pack`,
      headers: { cookie },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(json(r)).toMatchObject({
      pack_id: "us-ny-new-york-county",
      business_date: "2026-09-25",
      current: { version: "2026.09", effective_on: "2026-09-01" },
      next: {
        version: "2026.10",
        effective_on: "2026-09-26",
        changes: [{ path: "alcohol.lastSale", from: "04:00", to: "03:00" }],
      },
    });
  });
});
