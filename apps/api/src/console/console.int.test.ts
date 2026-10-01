import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { consoleVenues, generateSigningKey, publishRulePack, rulePackFor } from "@west4/db";
import {
  appPool,
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "@west4/db/test-helpers";
import { businessDate } from "@west4/rules";
import { SEED_NOW, SimulatedClock, Temporal, builtInRulePacks } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { SoftwarePasskey } from "../auth/test-passkey.js";

/**
 * M1-35 acceptance, API side. Sign-in is single sign-on (the local stub here)
 * and then a FIDO2 security key: without the key nothing opens, and a
 * phone's passkey is refused at enrolment. The venue list carries device
 * health from the device rows. Allowing a module for venue A makes it
 * switchable in Admin → Features at once; taking one away while it's on is
 * refused. A flag on venue B leaves venue A's flags unchanged. Every write
 * lands in the audit log with the staff member as actor.
 */
const CONSOLE = "http://localhost:5174";
const KEY = "f".repeat(64);
const STAFF_EMAIL = "sam@noraymi.test";
const SECOND_EMAIL = "kim@noraymi.test";

let db: TestDatabase;
let v: TwoVenues;
let app: FastifyInstance;
let pool: pg.Pool;
let staffId = "";
const clock = new SimulatedClock(SEED_NOW);
const securityKey = new SoftwarePasskey("localhost", "usb");
const secondKey = new SoftwarePasskey("localhost", "usb");
const phoneKey = new SoftwarePasskey("localhost", "internal");

const json = (r: { body: string }) =>
  JSON.parse(r.body) as Record<string, unknown> & { error?: { code: string; message: string } };
const cookiesOf = (r: { headers: Record<string, unknown> }): string => {
  const raw = r.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  return list.map((l) => String(l).split(";")[0]!).join("; ");
};
const call = (
  method: "GET" | "POST" | "PATCH" | "PUT",
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

/** Single sign-on (local stub), then the security key: enrol on the first sign-in, assert after that. */
async function signIn(
  key: SoftwarePasskey,
  email = STAFF_EMAIL,
): Promise<{ cookie: string; status: number; body: string }> {
  const sso = await call("POST", "/v1/console/auth/local", { email });
  expect(sso.statusCode, sso.body).toBe(200);
  const ssoCookie = cookiesOf(sso);
  const start = await call(
    "POST",
    "/v1/console/auth/key",
    { step: "start" },
    { cookie: ssoCookie },
  );
  expect(start.statusCode, start.body).toBe(200);
  const started = json(start) as { mode: "register" | "login"; options: { challenge: string } };
  const credential =
    started.mode === "register"
      ? key.register(started.options, CONSOLE)
      : key.assert(started.options, CONSOLE);
  const finish = await call(
    "POST",
    "/v1/console/auth/key",
    { step: "finish", credential, name: "Test key" },
    { cookie: ssoCookie },
  );
  return { cookie: cookiesOf(finish), status: finish.statusCode, body: finish.body };
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  pool = new pg.Pool({ connectionString: db.url, max: 2 });
  const config = loadConfig({
    WEST4_ENV: "local",
    DATABASE_URL: db.url,
    APP_DATABASE_URL: db.url,
    AUTH_SECRET_KEY: KEY,
    WEBAUTHN_RP_ID: "localhost",
    WEBAUTHN_ORIGINS: "http://localhost:5173",
    CONSOLE_URL: CONSOLE,
  });
  app = buildApp({ config, clock, moduleCacheMs: 0 });
  await app.ready();
  const s = await pool.query<{ id: string }>(
    "insert into console_staff (name, email) values ('Sam', $1) returning id",
    [STAFF_EMAIL],
  );
  staffId = s.rows[0]!.id;
  await pool.query("insert into console_staff (name, email) values ('Kim', $1)", [SECOND_EMAIL]);
  // The built-in pack, published the way `pnpm db:migrate` does it (M1-10).
  await publishRulePack(pool, {
    pack: builtInRulePacks[0]!,
    effectiveOn: "2026-09-01",
    approvedBy: ["Abhishek Gaire", "Claude Code"],
    privateKeyPem: generateSigningKey().privateKeyPem,
  });
  // Venue A's devices: 3 tablets (1 off), 2 readers online, a router with cellular backup.
  const rows: [string, string, boolean | null, Record<string, unknown> | null][] = [
    ["room_tablet", "Tablet · Room 1", true, null],
    ["room_tablet", "Tablet · Room 2", true, null],
    ["room_tablet", "Tablet · Room 4", false, null],
    ["reader", "Bar S710", true, null],
    ["reader", "Front desk S710", true, null],
    ["router", "Dual-WAN router", true, { cellular_backup: true, on_backup_now: false }],
  ];
  for (const [kind, name, online, network] of rows) {
    const d = await pool.query<{ id: string }>(
      "insert into devices (venue_id, kind, name) values ($1, $2, $3) returning id",
      [v.venueA, kind, name],
    );
    if (online !== null)
      await pool.query(
        "insert into device_heartbeats (device_id, venue_id, last_seen_at, offline_since, network) values ($1, $2, now(), $3, $4)",
        [d.rows[0]!.id, v.venueA, online ? null : new Date(), network],
      );
  }
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe("the Console", () => {
  let cookie = "";

  it("single sign-on alone opens nothing, a phone passkey is refused, and a security key signs in", async () => {
    const sso = await call("POST", "/v1/console/auth/local", { email: STAFF_EMAIL });
    expect(sso.statusCode).toBe(200);
    const withoutKey = await call("GET", "/v1/console/venues", undefined, {
      cookie: cookiesOf(sso),
    });
    expect(withoutKey.statusCode).toBe(403);
    expect(
      (await call("POST", "/v1/console/auth/local", { email: "stranger@example.com" })).statusCode,
    ).toBe(403);

    const phone = await signIn(phoneKey);
    expect(phone.status, phone.body).toBe(403);
    expect(phone.body).toMatch(/security key/);

    const key = await signIn(securityKey);
    expect(key.status, key.body).toBe(201);
    cookie = key.cookie;
    expect(cookie).toMatch(/west4_console=/);
    const me = await call("GET", "/v1/console/auth/me", undefined, { cookie });
    expect(me.statusCode).toBe(200);
    expect(json(me)["staff"]).toMatchObject({ email: STAFF_EMAIL, name: "Sam" });

    // The next sign-in asserts the enrolled key instead of enrolling again.
    const again = await signIn(securityKey);
    expect(again.status, again.body).toBe(201);
  });

  it("lists every venue with device health from the device rows: 2 of 3 tablets, both readers, backup internet on", async () => {
    const r = await call("GET", "/v1/console/venues", undefined, { cookie });
    expect(r.statusCode, r.body).toBe(200);
    const venues = json(r)["venues"] as Array<{ id: string; health: Record<string, unknown> }>;
    const a = venues.find((x) => x.id === v.venueA)!;
    expect(a.health).toMatchObject({
      tablets: { online: 2, total: 3 },
      readers: { online: 2, total: 2 },
      router: { online: true, backup_internet: "on", on_backup_now: false },
    });
    expect(venues.some((x) => x.id === v.venueB)).toBe(true);
    // The API's own role (app_rw) can't list venues; the Console's definer door can.
    const rw = appPool(db.url);
    try {
      const seen = await consoleVenues(rw);
      expect(seen.map((x) => x.id).sort()).toEqual([v.venueA, v.venueB].sort());
      await expect(rw.query("select id from venues")).rejects.toThrow(/app\.venue_id/);
    } finally {
      await rw.end();
    }
  });

  it("allowing a module makes it switchable in Admin at once; taking one away while it's on is refused", async () => {
    await pool.query(
      "update venue_modules set allowed = false, state = 'off' where venue_id = $1 and module_id = 'bar_mode'",
      [v.venueA],
    );
    const allow = await call(
      "PATCH",
      `/v1/console/venues/${v.venueA}/modules/bar_mode`,
      { allowed: true },
      { cookie },
    );
    expect(allow.statusCode, allow.body).toBe(200);
    const after = await pool.query<{ allowed: boolean }>(
      "select allowed from venue_modules where venue_id = $1 and module_id = 'bar_mode'",
      [v.venueA],
    );
    expect(after.rows[0]?.allowed).toBe(true);
    const event = await pool.query(
      "select 1 from venue_events where venue_id = $1 and type = 'settings.changed' and entity_id = 'modules'",
      [v.venueA],
    );
    expect(event.rowCount).toBeGreaterThan(0);

    // The venue turns it on (bar_mode needs bar_tabs, on by default); then the Console can't take it away.
    await pool.query(
      "update venue_modules set state = 'on' where venue_id = $1 and module_id = 'bar_mode'",
      [v.venueA],
    );
    const takeAway = await call(
      "PATCH",
      `/v1/console/venues/${v.venueA}/modules/bar_mode`,
      { allowed: false },
      { cookie },
    );
    expect(takeAway.statusCode).toBe(400);
    expect(json(takeAway).error?.message).toMatch(/turns off in Admin/);
    expect(
      (
        await call(
          "PATCH",
          `/v1/console/venues/${v.venueA}/modules/payments`,
          { allowed: false },
          { cookie },
        )
      ).statusCode,
    ).toBe(400);
  });

  it("a flag on venue B leaves venue A's flags unchanged, and the audit log names the staff member", async () => {
    const r = await call(
      "PUT",
      `/v1/console/venues/${v.venueB}/flags/beta.room_screen`,
      { on: true },
      { cookie },
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(json(r)["flags"]).toEqual({ "beta.room_screen": true });
    const a = await call("GET", `/v1/console/venues/${v.venueA}`, undefined, { cookie });
    expect(json(a)["flags"]).toEqual({});
    const flagsA = await pool.query("select 1 from venue_flags where venue_id = $1", [v.venueA]);
    expect(flagsA.rowCount).toBe(0);

    const audit = await pool.query<{ actor: string; action: string; target: string }>(
      `select actor, action, target from audit_log where venue_id = $1 and action like 'venue_flags.%' order by id desc limit 1`,
      [v.venueB],
    );
    expect(audit.rows[0]?.actor).toBe(staffId);
    const moduleAudit = await pool.query<{ actor: string }>(
      `select actor from audit_log where venue_id = $1 and action like 'venue\\_modules.%'
          and 'allowed' = any(changed_fields) order by id desc limit 1`,
      [v.venueA],
    );
    expect(moduleAudit.rows[0]?.actor).toBe(staffId);

    expect(
      (await call("PUT", `/v1/console/venues/${v.venueB}/flags/Bad Flag`, { on: true }, { cookie }))
        .statusCode,
    ).toBe(400);
  });

  it("a rule-pack version needs two different approvers; the same person twice counts once; then it signs and publishes", async () => {
    const base = builtInRulePacks[0]!;
    const next = { ...base, version: "2026.10", alcohol: { ...base.alcohol, lastSale: "03:00" } };
    const made = await call(
      "POST",
      "/v1/console/rule-packs/drafts",
      { effective_on: "2026-09-26", data: next },
      { cookie },
    );
    expect(made.statusCode, made.body).toBe(201);
    const draftId = (json(made)["draft"] as { id: string }).id;
    const publish = () =>
      call("POST", `/v1/console/rule-packs/drafts/${draftId}/publish`, {}, { cookie });
    expect((await publish()).statusCode).toBe(400);
    const approve = (c: string) =>
      call("POST", `/v1/console/rule-packs/drafts/${draftId}/approve`, {}, { cookie: c });
    expect((json(await approve(cookie))["approvers"] as string[]).length).toBe(1);
    expect((json(await approve(cookie))["approvers"] as string[]).length).toBe(1);
    const oneApproval = await publish();
    expect(oneApproval.statusCode).toBe(400);
    expect(json(oneApproval).error?.message).toMatch(/two different approvers/);

    const kim = await signIn(secondKey, SECOND_EMAIL);
    expect(kim.status, kim.body).toBe(201);
    expect((json(await approve(kim.cookie))["approvers"] as string[]).sort()).toEqual([
      "Kim",
      "Sam",
    ]);
    const done = await publish();
    expect(done.statusCode, done.body).toBe(200);
    expect(json(done)).toMatchObject({
      published: true,
      version: "2026.10",
      effective_on: "2026-09-26",
      changes: [{ path: "alcohol.lastSale", from: "04:00", to: "03:00" }],
    });
    expect((await publish()).statusCode).toBe(404);
    const list = json(await call("GET", "/v1/console/rule-packs", undefined, { cookie }));
    const pack = (list["packs"] as Array<{ id: string; versions: { version: string }[] }>).find(
      (p) => p.id === base.id,
    )!;
    expect(pack.versions.map((v) => v.version)).toEqual(["2026.09", "2026.10"]);

    // Business date Fri Sep 25 stays on 2026.09; the new version takes over at 6:00 AM on Sat Sep 26.
    const zone = "America/New_York";
    const fourAm = businessDate(
      Temporal.Instant.from("2026-09-26T08:00:00Z"),
      zone,
      "06:00",
    ).businessDate;
    const sixAm = businessDate(
      Temporal.Instant.from("2026-09-26T10:00:00Z"),
      zone,
      "06:00",
    ).businessDate;
    expect(fourAm.toString()).toBe("2026-09-25");
    expect(sixAm.toString()).toBe("2026-09-26");
    expect((await rulePackFor(pool, base.id, fourAm))?.version).toBe("2026.09");
    expect((await rulePackFor(pool, base.id, sixAm))?.version).toBe("2026.10");
    expect((await rulePackFor(pool, base.id, sixAm))?.pack.alcohol.lastSale).toBe("03:00");
  });

  it("logout ends the session", async () => {
    expect((await call("POST", "/v1/console/auth/logout", {}, { cookie })).statusCode).toBe(204);
    expect((await call("GET", "/v1/console/venues", undefined, { cookie })).statusCode).toBe(403);
  });
});
