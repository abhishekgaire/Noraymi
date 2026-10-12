import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  encryptSecret,
  generateSigningKey,
  loadDemoSeed,
  parseAuthSecretKey,
  publishRulePack,
  saveTwilioIntegration,
} from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/**
 * Set up your venue's steps 10 and 11 (O-12): the liquor license saved in the wizard is Admin →
 * Licenses' own row with its reminder; Register for texts sends one brand registration to Twilio
 * on the venue's subaccount (a stand-in for Twilio's Trust Hub here, as Twilio's test credentials
 * don't reach it), and the EIN is in no table and no log line; the website answer and the old
 * system's export files show in the Console, and nothing is imported from them.
 */
const KEY = "b".repeat(64);
const EIN = "84-1234567";
const EIN_DIGITS = "841234567";
let db: TestDatabase;
let owner: pg.Pool;
let app: FastifyInstance;
let twilio: Server;
let venueId: string;
const logged: string[] = [];
const seen: { path: string; body: string; token: string | undefined }[] = [];
const clock = new FrozenClock(SEED_NOW);
const people: Record<string, Principal> = {};

const call = (who: string, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  app.inject({
    method,
    url: url.startsWith("/v1/console") ? url : `/v1/venues/${venueId}${url}`,
    headers: { "x-test-as": who },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

const FORM = {
  ein: EIN,
  business_type: "Limited Liability Corporation",
  website_url: "https://example.com",
  rep: {
    first_name: "Rae",
    last_name: "Kim",
    email: "rae@example.com",
    phone_e164: "+12125550111",
    title: "Owner",
    position: "GM",
  },
  samples: [
    "Menu Step: your room is ready. Show this text at the front desk.",
    "Menu Step: your booking for Friday at 9 PM is confirmed. Reply STOP to opt out.",
  ],
};

const body = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let text = "";
    req.on("data", (chunk) => (text += String(chunk)));
    req.on("end", () => resolve(text));
  });

beforeAll(async () => {
  twilio = createServer((req, res) => {
    void body(req).then((text) => {
      seen.push({
        path: req.url ?? "",
        body: decodeURIComponent(text.replace(/\+/g, " ")),
        token: req.headers["i-twilio-idempotency-token"] as string | undefined,
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ sid: `XX${String(seen.length).padStart(32, "0")}` }));
    });
  });
  await new Promise<void>((resolve) => twilio.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(twilio.address() as AddressInfo).port}`;
  Object.assign(process.env, {
    TWILIO_TRUSTHUB_BASE: base,
    TWILIO_MESSAGING_BASE: base,
    TWILIO_API_BASE: base,
    TWILIO_PRIMARY_PROFILE_SID: "BU00000000000000000000000000000001",
    TWILIO_ISV_EMAIL: "isv@ops.test",
  });

  db = await createTestDatabase({ migrate: true });
  await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } });
  owner = new pg.Pool({ connectionString: db.url });
  await publishRulePack(owner, {
    pack: newYorkCounty,
    effectiveOn: "2026-09-01",
    approvedBy: ["A", "B"],
    privateKeyPem: generateSigningKey().privateKeyPem,
  });
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
  });
  await app.ready();

  const org = await owner.query<{ id: string }>(
    "insert into organizations (legal_name) values ('Menu Step LLC') returning id",
  );
  venueId = (
    await owner.query<{ id: string }>(
      `insert into venues (org_id, name, slug, rule_pack_id, address)
         values ($1, 'Menu Step', 'texts-step', 'us-ny-new-york-county',
                 '{"line1": "1 Test St", "city": "New York", "state": "NY", "postal_code": "10012"}')
       returning id`,
      [org.rows[0]!.id],
    )
  ).rows[0]!.id;
  for (const [who, role] of [
    ["owner", "owner"],
    ["manager", "manager"],
  ] as const) {
    const u = await owner.query<{ id: string }>(
      "insert into users (name, email) values ($1, $2) returning id",
      [who, `${who}@texts.test`],
    );
    const m = await owner.query<{ id: string }>(
      "insert into memberships (venue_id, user_id, role, status, pin_digits) values ($1, $2, $3, 'active', 6) returning id",
      [venueId, u.rows[0]!.id, role],
    );
    people[who] = {
      kind: "user",
      userId: u.rows[0]!.id,
      session: "passkey",
      memberships: [{ venueId, membershipId: m.rows[0]!.id, role }],
    };
  }
  const staff = await owner.query<{ id: string }>(
    "insert into console_staff (name, email) values ('Ana', 'ana@texts.test') returning id",
  );
  people["console"] = {
    kind: "console",
    staffId: staff.rows[0]!.id,
    name: "Ana",
    email: "ana@texts.test",
  } as Principal;
});

afterAll(async () => {
  await app?.close();
  await owner?.end();
  await db?.drop();
  await new Promise((resolve) => twilio?.close(resolve));
});

describe("Step 10: licenses (O-12)", () => {
  it("the liquor license saved in the wizard is Admin → Licenses' row, with its reminder", async () => {
    const steps = async () =>
      (
        (await call("owner", "GET", "/setup")).json() as {
          checklist: { steps: { id: string; mark: string }[] };
        }
      ).checklist.steps.find((s) => s.id === "licenses")!.mark;
    expect(await steps()).not.toBe("done");
    const made = await call("owner", "POST", "/licenses", {
      kind: "liquor",
      number: "TEST-0001",
      expires_on: "2026-11-01",
    });
    expect(made.statusCode, made.body).toBe(201);
    const list = (await call("owner", "GET", "/licenses")).json() as {
      licenses: { kind: string; days_left: number | null }[];
    };
    expect(list.licenses.find((l) => l.kind === "liquor")?.days_left).toBeGreaterThan(0);
    expect(await steps()).toBe("done");
  });
});

describe("Step 11: texts registration, the website and the old system's files (O-12)", () => {
  it("before the subaccount exists, the step says so and Register for texts is refused", async () => {
    expect((await call("owner", "GET", "/setup/texts")).json()).toMatchObject({
      subaccount: false,
      registration: null,
    });
    const r = await call("owner", "POST", "/setup/texts/register", FORM);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: { details: { reason: "no_subaccount" } } });
    expect(seen).toHaveLength(0);
  });

  it("only the owner registers; a half-filled form names fields, never values", async () => {
    await owner.query("select set_config('app.venue_id', $1, false)", [venueId]);
    await saveTwilioIntegration(owner, venueId, {
      accountSid: "AC00000000000000000000000000000009",
      phoneE164: "+12125550190",
      secretEnc: encryptSecret(parseAuthSecretKey(KEY), "subaccount-token"),
      at: SEED_NOW.toString(),
    });
    expect((await call("manager", "POST", "/setup/texts/register", FORM)).statusCode).toBe(403);
    const half = await call("owner", "POST", "/setup/texts/register", { ...FORM, rep: {} });
    expect(half.statusCode).toBe(400);
    expect(half.body).not.toContain(EIN);
  });

  it("sends one brand registration on the venue's subaccount, and the EIN is in no table and no log", async () => {
    const r = await call("owner", "POST", "/setup/texts/register", FORM);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ state: "submitted", legal_name: "Menu Step LLC" });
    expect(r.body).not.toContain(EIN_DIGITS);
    expect(seen.filter((s) => s.path === "/v1/a2p/BrandRegistrations")).toHaveLength(1);
    expect(seen.some((s) => s.path.includes("/Accounts/AC00000000000000000000000000000009/"))).toBe(
      true,
    );
    // The EIN goes in one request, and every request carries an idempotency token.
    expect(seen.filter((s) => s.body.includes(EIN_DIGITS))).toHaveLength(1);
    expect(seen.every((s) => s.token?.startsWith("west4-brand-"))).toBe(true);
    expect(new Set(seen.map((s) => s.token)).size).toBe(seen.length);

    // A second press sends nothing more.
    const again = await call("owner", "POST", "/setup/texts/register", FORM);
    expect(again.statusCode).toBe(409);
    expect(seen.filter((s) => s.path === "/v1/a2p/BrandRegistrations")).toHaveLength(1);

    const tables = await owner.query<{ name: string }>(
      `select format('%I.%I', table_schema, table_name) as name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const holding: string[] = [];
    for (const { name } of tables.rows) {
      const hit = await owner.query(
        `select 1 from ${name} t where t::text like $1 or t::text like $2 limit 1`,
        [`%${EIN_DIGITS}%`, `%${EIN}%`],
      );
      if (hit.rowCount) holding.push(name);
    }
    expect(holding).toEqual([]);
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.filter((l) => l.includes(EIN_DIGITS) || l.includes(EIN))).toEqual([]);
  });

  it("the website answer and the old system's files show in the Console; nothing is imported", async () => {
    const yes = await call("manager", "POST", "/setup/website", {
      answer: "yes",
      domain: "example.com",
    });
    expect(yes.statusCode, yes.body).toBe(201);
    expect(yes.json()).toMatchObject({ kind: "website", answer: "yes", state: "open" });
    const upload = await call("manager", "POST", "/files", {
      kind: "import_export",
      content_type: "text/csv",
      bytes: 4096,
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const sent = await call("manager", "POST", "/setup/requests", {
      kind: "old_system",
      file_id: (upload.json() as { file_id: string }).file_id,
      note: "Bookings export from the old system",
    });
    expect(sent.statusCode, sent.body).toBe(201);
    const step = (await call("owner", "GET", "/setup/texts")).json() as {
      requests: { kind: string }[];
    };
    expect(step.requests.map((r) => r.kind).sort()).toEqual(["old_system", "website"]);
    const consoleList = (
      await call("console", "GET", `/v1/console/venues/${venueId}/setup-requests`)
    ).json() as { requests: { kind: string; state: string }[] };
    expect(
      consoleList.requests
        .filter((r) => r.state === "open")
        .map((r) => r.kind)
        .sort(),
    ).toEqual(["old_system", "website"]);
    const runs = await owner.query("select 1 from import_runs where venue_id = $1", [venueId]);
    expect(runs.rowCount).toBe(0);
  });
});
