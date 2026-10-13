import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { decryptSecret, loadDemoSeed, parseAuthSecretKey } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { FakeTwilioAdmin, HttpTwilioAdmin } from "../texts/connect.js";

/**
 * Connect your Twilio account (T-01; D123): a venue's own Twilio account, checked with a read-only
 * call, its number pointed at our webhook and put in its messaging service, the campaign read, and
 * the Auth Token kept only encrypted: in no response, no log line and no other table. A stand-in
 * answers as Twilio does (Twilio's test credentials can't read numbers or services).
 */
const KEY = "c".repeat(64);
const SID_A = `AC${"a".repeat(32)}`;
const SID_B = `AC${"b".repeat(32)}`;
const TOKEN = "0123456789abcdef0123456789abcdef";
const NUMBER = `PN${"1".repeat(32)}`;
const UK_NUMBER = `PN${"2".repeat(32)}`;
const SERVICE = `MG${"3".repeat(32)}`;
let db: TestDatabase;
let owner: pg.Pool;
let app: FastifyInstance;
let twilio: Server;
let venueId: string;
let otherVenueId: string;
let campaignState = "IN_PROGRESS";
const logged: string[] = [];
const seen: { method: string; path: string; body: string }[] = [];
const clock = new FrozenClock(SEED_NOW);
const people: Record<string, Principal> = {};

const call = (
  who: string,
  method: "GET" | "POST",
  url: string,
  payload?: unknown,
  venue = venueId,
) =>
  app.inject({
    method,
    url: `/v1/venues/${venue}${url}`,
    headers: { "x-test-as": who },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

const read = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let text = "";
    req.on("data", (chunk) => (text += String(chunk)));
    req.on("end", () => resolve(text));
  });

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
};

beforeAll(async () => {
  twilio = createServer((req, res) => {
    void read(req).then((body) => {
      const path = req.url ?? "";
      seen.push({ method: req.method ?? "", path, body: decodeURIComponent(body) });
      const auth = Buffer.from(
        (req.headers.authorization ?? "").replace(/^Basic /, ""),
        "base64",
      ).toString();
      if (auth.split(":")[1] !== TOKEN) return json(res, 401, { code: 20003 });
      if (/^\/2010-04-01\/Accounts\/AC\w+\.json$/.test(path))
        return json(res, 200, { friendly_name: "Menu Step", status: "active", type: "Full" });
      if (path.includes("/IncomingPhoneNumbers.json"))
        return json(res, 200, {
          incoming_phone_numbers: [
            { sid: NUMBER, phone_number: "+12125550177", capabilities: { sms: true } },
            { sid: UK_NUMBER, phone_number: "+442071234567", capabilities: { sms: true } },
          ],
          next_page_uri: null,
        });
      if (path.includes("/IncomingPhoneNumbers/")) return json(res, 200, { sid: NUMBER });
      if (path.startsWith("/v1/Services?"))
        return json(res, 200, {
          services: [{ sid: SERVICE, friendly_name: "Menu Step texts" }],
          meta: { next_page_url: null },
        });
      // Already in the service: Twilio's 21710, which counts as done.
      if (path.endsWith("/PhoneNumbers")) return json(res, 409, { code: 21710 });
      if (path.endsWith("/Compliance/Usa2p"))
        return json(res, 200, { compliance: [{ campaign_status: campaignState }] });
      if (path === `/v1/Services/${SERVICE}`) return json(res, 200, { sid: SERVICE });
      return json(res, 404, {});
    });
  });
  await new Promise<void>((resolve) => twilio.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(twilio.address() as AddressInfo).port}`;
  process.env["PUBLIC_API_URL"] = "https://api.test";

  db = await createTestDatabase({ migrate: true });
  await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } });
  owner = new pg.Pool({ connectionString: db.url });
  app = buildApp({
    config: loadConfig({
      WEST4_ENV: "local",
      DATABASE_URL: db.url,
      APP_DATABASE_URL: db.url.replace("//west4:west4@", "//app_rw:app_rw@"),
      AUTH_SECRET_KEY: KEY,
    }),
    clock,
    logger: { level: "debug", stream: { write: (line) => void logged.push(line) } },
    authenticators: [
      async (request) => {
        const who = request.headers["x-test-as"];
        return typeof who === "string" ? people[who] : undefined;
      },
    ],
    moduleCacheMs: 0,
    twilioAdmin: new HttpTwilioAdmin(base, base),
  });
  await app.ready();

  const org = await owner.query<{ id: string }>(
    "insert into organizations (legal_name) values ('Menu Step LLC') returning id",
  );
  const venue = async (slug: string) =>
    (
      await owner.query<{ id: string }>(
        `insert into venues (org_id, name, slug, rule_pack_id) values ($1, $2, $2, 'us-ny-new-york-county') returning id`,
        [org.rows[0]!.id, slug],
      )
    ).rows[0]!.id;
  venueId = await venue("twilio-a");
  otherVenueId = await venue("twilio-b");
  for (const [who, role, v] of [
    ["owner", "owner", venueId],
    ["manager", "manager", venueId],
    ["bartender", "bartender", venueId],
    ["otherOwner", "owner", otherVenueId],
  ] as const) {
    const u = await owner.query<{ id: string }>(
      "insert into users (name, email) values ($1, $2) returning id",
      [who, `${who}@twilio.test`],
    );
    const m = await owner.query<{ id: string }>(
      "insert into memberships (venue_id, user_id, role, status, pin_digits) values ($1, $2, $3, 'active', 6) returning id",
      [v, u.rows[0]!.id, role],
    );
    people[who] = {
      kind: "user",
      userId: u.rows[0]!.id,
      session: "passkey",
      memberships: [{ venueId: v, membershipId: m.rows[0]!.id, role }],
    };
  }
});

afterAll(async () => {
  delete process.env["PUBLIC_API_URL"];
  await app?.close();
  await owner?.end();
  await db?.drop();
  await new Promise((resolve) => twilio?.close(resolve));
});

const KEYS = { account_sid: SID_A, auth_token: TOKEN };
const CONNECT = { ...KEYS, number_sid: NUMBER, service_sid: SERVICE };

describe("Connect your Twilio account (T-01)", () => {
  it("starts not connected", async () => {
    const r = await call("owner", "GET", "/texts/twilio");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ state: "not_connected", number: null, live: false });
  });

  it("Check lists the account's +1 numbers and services and saves nothing", async () => {
    const r = await call("manager", "POST", "/texts/twilio/check", KEYS);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      account: { sid_last4: "aaaa", name: "Menu Step", trial: false },
      numbers: [{ sid: NUMBER, phone_e164: "+12125550177", name: "" }],
      services: [{ sid: SERVICE, name: "Menu Step texts" }],
    });
    expect(seen.every((s) => s.method === "GET")).toBe(true);
    const rows = await owner.query("select 1 from integrations where venue_id = $1", [venueId]);
    expect(rows.rowCount).toBe(0);
  });

  it("wrong keys are refused as Twilio's answer; a half-filled form names fields, not values", async () => {
    const wrong = await call("owner", "POST", "/texts/twilio/check", {
      ...KEYS,
      auth_token: "f".repeat(32),
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.details).toEqual({ reason: "twilio_refused" });
    const half = await call("owner", "POST", "/texts/twilio/check", { account_sid: SID_A });
    expect(half.statusCode).toBe(400);
    expect(half.body).not.toContain(SID_A);
  });

  it("a bartender can't connect", async () => {
    expect((await call("bartender", "POST", "/texts/twilio", CONNECT)).statusCode).toBe(403);
    expect((await call("bartender", "GET", "/texts/twilio")).statusCode).toBe(403);
  });

  it("Connect points the number at our webhook, joins the service, reads the campaign and keeps the token encrypted", async () => {
    seen.length = 0;
    const r = await call("owner", "POST", "/texts/twilio", CONNECT);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      state: "waiting",
      account: { sid_last4: "aaaa", name: "Menu Step", trial: false },
      number: "+12125550177",
      service_sid: SERVICE,
      campaign: "pending",
      live: true, // a local server doesn't wait for the campaign
    });
    expect(r.body).not.toContain(TOKEN);
    const incoming = seen.find((s) => s.path.includes(`/IncomingPhoneNumbers/${NUMBER}.json`));
    expect(incoming?.body).toContain("SmsUrl=https://api.test/v1/hooks/twilio");
    expect(seen.some((s) => s.method === "POST" && s.path.endsWith("/PhoneNumbers"))).toBe(true);
    expect(seen.some((s) => s.body.includes("UseInboundWebhookOnNumber=true"))).toBe(true);

    const row = (
      await owner.query<{ external_id: string; config: { secret_enc: string } }>(
        "select external_id, config from integrations where venue_id = $1 and kind = 'twilio'",
        [venueId],
      )
    ).rows[0]!;
    expect(row.external_id).toBe(SID_A);
    expect(decryptSecret(parseAuthSecretKey(KEY), row.config.secret_enc)).toBe(TOKEN);
    expect(JSON.stringify(row.config)).not.toContain(TOKEN);
    // The token is nowhere else in the database, and in no log line.
    const tables = await owner.query<{ name: string }>(
      `select format('%I.%I', table_schema, table_name) as name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const holding: string[] = [];
    for (const { name } of tables.rows) {
      const hit = await owner.query(`select 1 from ${name} t where t::text like $1 limit 1`, [
        `%${TOKEN}%`,
      ]);
      if (hit.rowCount) holding.push(name);
    }
    expect(holding).toEqual([]);
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.filter((l) => l.includes(TOKEN))).toEqual([]);
  });

  it("Check again reads the campaign's status from Twilio", async () => {
    campaignState = "VERIFIED";
    const r = await call("manager", "POST", "/texts/twilio/refresh");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ state: "approved", campaign: "approved", live: true });
  });

  it("another venue can't connect the same account, and nothing at Twilio changes for it", async () => {
    seen.length = 0;
    const r = await call("otherOwner", "POST", "/texts/twilio", CONNECT, otherVenueId);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.details).toEqual({ reason: "account_in_use" });
    expect(seen.filter((s) => s.method === "POST")).toEqual([]);
  });

  it("Replace keys connects again; Disconnect forgets the keys at once", async () => {
    expect((await call("owner", "POST", "/texts/twilio", CONNECT)).statusCode).toBe(200);
    const gone = await call("manager", "POST", "/texts/twilio/disconnect");
    expect(gone.statusCode).toBe(200);
    expect(gone.json()).toMatchObject({ state: "not_connected" });
    const row = (
      await owner.query<{ status: string; external_id: string | null; config: object }>(
        "select status, external_id, config from integrations where venue_id = $1 and kind = 'twilio'",
        [venueId],
      )
    ).rows[0]!;
    expect(row).toEqual({ status: "disconnected", external_id: null, config: {} });
    expect((await call("owner", "GET", "/texts/twilio")).json().state).toBe("not_connected");
    expect((await call("owner", "POST", "/texts/twilio/refresh")).statusCode).toBe(409);
    // The other venue may now connect that account.
    expect(
      (await call("otherOwner", "POST", "/texts/twilio", CONNECT, otherVenueId)).statusCode,
    ).toBe(200);
  });
});

describe("the fake Twilio (local, demo and browser tests)", () => {
  it("passes well-formed keys, refuses 32 zeros, and approves on the second read", async () => {
    const fake = new FakeTwilioAdmin();
    const a = { accountSid: SID_A, authToken: TOKEN };
    expect(await fake.account(a)).toEqual({ name: "Test account", trial: false });
    const [n] = await fake.numbers(a);
    const [n2] = await fake.numbers({ accountSid: SID_B, authToken: TOKEN });
    expect(n!.phoneE164).toMatch(/^\+1212555\d{4}$/);
    expect(n!.phoneE164).not.toBe(n2!.phoneE164);
    const [s] = await fake.services(a);
    expect(await fake.campaign(a, s!.sid)).toBe("pending");
    expect(await fake.campaign(a, s!.sid)).toBe("approved");
    await expect(fake.account({ accountSid: SID_A, authToken: "0".repeat(32) })).rejects.toThrow();
  });
});
