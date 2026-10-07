import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed, openConsoleSession } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, Temporal } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { CONSOLE_COOKIE, SUPPORT_GRANT_HEADER } from "../console/auth.js";
import type { Principal } from "../http/principal.js";

/**
 * M8-10 acceptance on the demo seed. Our support staff ask in the Console;
 * the grant opens only after Abhishek approves it in Admin → Console, and Andy
 * (a manager) can't see or answer it. During a read grant the support session
 * reads masked guest phone numbers and no ID scans, and every write is
 * refused. A write grant runs its one named action once. The grant ends by
 * itself at 60 minutes on the simulated clock, and Abhishek's End now ends it
 * at once. Every audit row written under the grant names our staff member and
 * the grant.
 */
let db: TestDatabase;
let raw: pg.Client;
let app: FastifyInstance;
let venueId = "";
let staffId = "";
let cookie = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
const people: Record<string, Principal> = {};

type Json = Record<string, unknown> & {
  support_grant?: { id: string; state: string; seconds_left: number | null };
  support_grants?: { id: string; state: string }[];
  error?: { code: string };
};
const body = (r: { body: string }) => JSON.parse(r.body) as Json;

const asVenue = (who: string, method: "GET" | "POST", path: string, payload?: object) =>
  app.inject({
    method,
    url: `/v1/venues/${venueId}${path}`,
    headers: { "x-test-as": who },
    ...(payload ? { payload } : {}),
  });
const consoleCall = (method: "GET" | "POST", path: string, payload?: object) =>
  app.inject({ method, url: path, headers: { cookie }, ...(payload ? { payload } : {}) });
const asSupport = (grantId: string, method: "GET" | "POST", path: string, payload?: object) =>
  app.inject({
    method,
    url: `/v1/venues/${venueId}${path}`,
    headers: { cookie, [SUPPORT_GRANT_HEADER]: grantId },
    ...(payload ? { payload } : {}),
  });

async function freshConsoleSession() {
  const session = await openConsoleSession(raw, {
    staffId,
    startedAt: clock.now().toString(),
    expiresAt: clock.now().add({ hours: 12 }).toString(),
  });
  cookie = `${CONSOLE_COOKIE}=${session.token}`;
}

async function request(scope: "read" | "write", minutes = 60) {
  const r = await consoleCall("POST", `/v1/console/venues/${venueId}/support-grants`, {
    reason: "Checking why a bar ticket didn't print",
    scope,
    ...(scope === "write" ? { action: "requeue_print" } : {}),
    minutes,
  });
  expect(r.statusCode).toBe(200);
  return body(r).support_grant!;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  ids = Object.fromEntries(
    (
      await raw.query<{ slug: string; id: string }>(
        "select slug, row_id as id from seed_ids where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.slug, r.id]),
  );
  for (const [who, role] of [
    ["abhishek", "owner"],
    ["andy", "manager"],
  ] as const)
    people[who] = {
      kind: "user",
      userId: ids[who]!,
      session: "passkey",
      memberships: [{ venueId, membershipId: ids[`${who}.membership`]!, role }],
    };
  staffId = (
    await raw.query<{ id: string }>(
      "select id from console_staff where email = 'support@demo.west4.local'",
    )
  ).rows[0]!.id;
  await freshConsoleSession();
  app = buildApp({
    config: loadConfig({
      WEST4_ENV: "local",
      DATABASE_URL: db.url,
      APP_DATABASE_URL: db.url,
      CONSOLE_URL: "http://localhost:5174",
    }),
    clock,
    authenticators: [
      async (request) => {
        const who = request.headers["x-test-as"];
        return typeof who === "string" ? people[who] : undefined;
      },
    ],
    moduleCacheMs: 0,
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await raw?.end();
  await db?.drop();
});

describe("support grants (M8-10)", () => {
  it("opens a read grant only after Abhishek approves it; Andy has no Console", async () => {
    const g = await request("read");
    expect(g.state).toBe("waiting");
    // Waiting: the support session opens nothing yet.
    expect((await asSupport(g.id, "GET", "/support/view")).statusCode).toBe(403);
    // A push went to the owner.
    const push = await raw.query<{ payload: { audience: unknown; message: { key: string } } }>(
      "select payload from jobs where venue_id = $1 and dedupe_key = $2",
      [venueId, `support-request:${g.id}`],
    );
    expect(push.rows[0]!.payload).toMatchObject({
      audience: { kind: "role", role: "owner" },
      message: { key: "support.push.request", url: "/admin/console" },
    });

    // Andy, a manager, can neither list nor answer it.
    expect((await asVenue("andy", "GET", "/support-grants")).statusCode).toBe(403);
    expect((await asVenue("andy", "POST", `/support-grants/${g.id}/approve`)).statusCode).toBe(403);
    const mine = await asVenue("abhishek", "GET", "/support-grants");
    expect(body(mine).support_grants!.find((x) => x.id === g.id)?.state).toBe("waiting");

    const ok = await asVenue("abhishek", "POST", `/support-grants/${g.id}/approve`);
    expect(ok.statusCode).toBe(200);
    expect(body(ok).support_grant).toMatchObject({ state: "open", seconds_left: 3600 });
    expect((await asSupport(g.id, "GET", "/support/view")).statusCode).toBe(200);
    // Answering twice is a conflict.
    expect((await asVenue("abhishek", "POST", `/support-grants/${g.id}/decline`)).statusCode).toBe(
      409,
    );
    await asVenue("abhishek", "POST", `/support-grants/${g.id}/revoke`);
  });

  it("shows masked phone numbers and no ID scans, and refuses every write", async () => {
    const g = await request("read");
    await asVenue("abhishek", "POST", `/support-grants/${g.id}/approve`);
    const r = await asSupport(g.id, "GET", "/support/view");
    expect(r.statusCode).toBe(200);
    const view = body(r) as unknown as {
      guests: { name: string; phone_masked: string | null }[];
    };
    expect(view.guests.length).toBeGreaterThan(0);
    const phones = await raw.query<{ phone_e164: string }>(
      "select phone_e164 from guests where venue_id = $1 and phone_e164 is not null",
      [venueId],
    );
    expect(phones.rows.length).toBeGreaterThan(0);
    for (const { phone_e164 } of phones.rows) expect(r.body).not.toContain(phone_e164.slice(2));
    expect(
      view.guests.every((x) => x.phone_masked === null || /^••• ••• \d\d$/.test(x.phone_masked)),
    ).toBe(true);
    expect(Object.keys(view)).not.toContain("id_checks");
    // The venue wall: West 4's grant opens nothing at another venue.
    const elsewhere = await app.inject({
      method: "GET",
      url: "/v1/venues/00000000-0000-4000-8000-0000000000bb/support/view",
      headers: { cookie, [SUPPORT_GRANT_HEADER]: g.id },
    });
    expect(elsewhere.statusCode).toBe(403);
    // The staff routes (with the full check and guest) aren't open to support.
    const check = await raw.query<{ id: string }>(
      "select id from checks where venue_id = $1 limit 1",
      [venueId],
    );
    expect((await asSupport(g.id, "GET", `/checks/${check.rows[0]!.id}`)).statusCode).toBe(403);
    // Writes: a read grant has no action, and no other write route takes support.
    const job = await raw.query<{ id: string }>(
      "select id from print_jobs where venue_id = $1 limit 1",
      [venueId],
    );
    const jobId = job.rows[0]?.id ?? "00000000-0000-4000-8000-000000000001";
    expect(
      (await asSupport(g.id, "POST", "/support/actions/requeue_print", { job_id: jobId }))
        .statusCode,
    ).toBe(403);
    expect((await asSupport(g.id, "POST", "/licenses", { kind: "bmi" })).statusCode).toBe(403);
    await asVenue("abhishek", "POST", `/support-grants/${g.id}/revoke`);
  });

  it("runs a write grant's one named action once; a second try and other writes fail; audit names both", async () => {
    const job = await raw.query<{ id: string }>(
      `insert into print_jobs (venue_id, check_id, kind, station, payload, status, failed_at)
       select venue_id, id, 'check', 'bar', '{"lines":[]}', 'failed', $2 from checks
        where venue_id = $1 and not training limit 1 returning id`,
      [venueId, SEED_NOW.toString()],
    );
    const jobId = job.rows[0]!.id;
    const g = await request("write");
    await asVenue("abhishek", "POST", `/support-grants/${g.id}/approve`);
    const first = await asSupport(g.id, "POST", "/support/actions/requeue_print", {
      job_id: jobId,
    });
    expect(first.statusCode).toBe(200);
    const again = await asSupport(g.id, "POST", "/support/actions/requeue_print", {
      job_id: jobId,
    });
    expect(again.statusCode).toBe(403);
    expect(
      (await asSupport(g.id, "POST", "/support/actions/close_night", { job_id: jobId })).statusCode,
    ).toBe(404);
    expect((await asSupport(g.id, "POST", "/licenses", { kind: "bmi" })).statusCode).toBe(403);
    // Reads still work for the rest of the grant.
    expect((await asSupport(g.id, "GET", "/support/view")).statusCode).toBe(200);
    const audit = await raw.query<{ actor: string; support_grant_id: string | null }>(
      "select actor, support_grant_id from audit_log where venue_id = $1 and support_grant_id = $2",
      [venueId, g.id],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(audit.rows.every((a) => a.actor === staffId && a.support_grant_id === g.id)).toBe(true);
    const chain = await raw.query<{ id: string | null }>("select verify_audit_chain($1) as id", [
      venueId,
    ]);
    expect(chain.rows[0]!.id).toBeNull();
    await asVenue("abhishek", "POST", `/support-grants/${g.id}/revoke`);
  });

  it("ends by itself at 60 minutes, and Abhishek's End now ends it at once", async () => {
    const g = await request("read");
    await asVenue("abhishek", "POST", `/support-grants/${g.id}/approve`);
    clock.advance(Temporal.Duration.from({ minutes: 59, seconds: 59 }));
    await freshConsoleSession(); // the Console's own idle limit is 30 minutes
    expect((await asSupport(g.id, "GET", "/support/view")).statusCode).toBe(200);
    clock.advance(Temporal.Duration.from({ seconds: 1 }));
    expect((await asSupport(g.id, "GET", "/support/view")).statusCode).toBe(403);
    const list = body(await asVenue("abhishek", "GET", "/support-grants")).support_grants!;
    expect(list.find((x) => x.id === g.id)?.state).toBe("ended");

    const h = await request("read", 30);
    await asVenue("abhishek", "POST", `/support-grants/${h.id}/approve`);
    expect((await asSupport(h.id, "GET", "/support/view")).statusCode).toBe(200);
    const end = await asVenue("abhishek", "POST", `/support-grants/${h.id}/revoke`);
    expect(body(end).support_grant!.state).toBe("revoked");
    expect((await asSupport(h.id, "GET", "/support/view")).statusCode).toBe(403);
    // The Console sees it ended.
    const seen = body(await consoleCall("GET", `/v1/console/venues/${venueId}/support-grants`));
    expect(seen.support_grants!.find((x) => x.id === h.id)?.state).toBe("revoked");
  });

  it("refuses a request longer than 60 minutes, or a write without a named action", async () => {
    for (const bad of [
      { reason: "long one", scope: "read", minutes: 61 },
      { reason: "write", scope: "write", minutes: 10 },
      { reason: "write", scope: "write", action: "drop_tables", minutes: 10 },
    ])
      expect(
        (await consoleCall("POST", `/v1/console/venues/${venueId}/support-grants`, bad)).statusCode,
      ).toBe(400);
  });
});
