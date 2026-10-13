import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/**
 * Set up your venue's steps 10 and 11 (O-12): the liquor license saved in the wizard is Admin →
 * Licenses' own row with its reminder; step 11 asks for no EIN (the venue registers its texting
 * brand in Twilio's own console and connects its account, T-01; D123); the website answer and the
 * old system's export files show in the Console, and nothing is imported from them.
 */
const KEY = "b".repeat(64);
let db: TestDatabase;
let owner: pg.Pool;
let app: FastifyInstance;
let venueId: string;
const logged: string[] = [];
const clock = new FrozenClock(SEED_NOW);
const people: Record<string, Principal> = {};

const call = (who: string, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  app.inject({
    method,
    url: url.startsWith("/v1/console") ? url : `/v1/venues/${venueId}${url}`,
    headers: { "x-test-as": who },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

beforeAll(async () => {
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

describe("Step 11: the website and the old system's files (O-12)", () => {
  it("asks for no EIN and has no Register for texts: the venue registers in Twilio's console (D123)", async () => {
    expect((await call("owner", "GET", "/setup/texts")).json()).toEqual(
      expect.objectContaining({ requests: [] }),
    );
    const gone = await call("owner", "POST", "/setup/texts/register", { ein: "84-1234567" });
    expect(gone.statusCode).toBe(404);
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
