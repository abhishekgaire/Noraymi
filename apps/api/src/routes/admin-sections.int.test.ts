import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { withVenue } from "@west4/db";
import {
  appPool,
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { SoftwarePasskey } from "../auth/test-passkey.js";

/**
 * P-10 · Can also open (spec 02 · Roles): the owner gives a bartender Admin → Licenses on top of
 * her role. In her passkey session that section's routes open, read and write; a section she wasn't
 * given, Team, the reports and the glance stay refused, and a PIN session opens nothing. A manager
 * can't give one; an owner's or manager's role already has them; venue B's person isn't found;
 * taking it back closes it at once. Each grant is audited, and app_rw can add and stamp a grant
 * but never delete one.
 */
const ORIGIN = "http://localhost:5173";
const KEY = "e".repeat(64);
const OWNER_EMAIL = "owner-a@example.com";
const ANDY_EMAIL = "andy-a@example.com";
const MAYA_EMAIL = "maya-a@example.com";

let db: TestDatabase;
let v: TwoVenues;
let app: FastifyInstance;
let owner: pg.Pool;
let rw: pg.Pool;
const clock = new SimulatedClock(SEED_NOW);
let maya = "";
let andy = "";
let staffB = "";
const ownerKey = new SoftwarePasskey("localhost");
const andyKey = new SoftwarePasskey("localhost");
const mayaKey = new SoftwarePasskey("localhost");
let ownerCookie = "";
let andyCookie = "";
let mayaCookie = "";

const json = (r: { body: string }) =>
  JSON.parse(r.body) as Record<string, unknown> & {
    error?: { code: string; message: string; details?: Record<string, unknown> };
  };
const cookieOf = (r: { headers: Record<string, unknown> }) => {
  const raw = r.headers["set-cookie"];
  const line = Array.isArray(raw) ? raw[0] : raw;
  return typeof line === "string" ? line.split(";")[0]! : "";
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
const venue = (path: string) => `/v1/venues/${v.venueA}${path}`;

async function enrol(email: string, key: SoftwarePasskey): Promise<string> {
  expect((await call("POST", "/v1/auth/enroll", { step: "start", email })).statusCode).toBe(200);
  const r = await owner.query<{ payload: { data: { code: string } } }>(
    "select payload from jobs where kind = 'email.send' and payload->>'to' = $1 order by created_at desc limit 1",
    [email],
  );
  const code = r.rows[0]!.payload.data.code;
  const opts = json(
    await call("POST", "/v1/auth/enroll", { step: "passkey_options", email, code }),
  );
  const finish = await call("POST", "/v1/auth/enroll", {
    step: "passkey_finish",
    email,
    code,
    credential: key.register(opts["options"] as { challenge: string }, ORIGIN),
    name: "Phone",
    client: "web",
  });
  expect(finish.statusCode, finish.body).toBe(201);
  return cookieOf(finish);
}

async function stepUp(cookie: string, key: SoftwarePasskey): Promise<Record<string, string>> {
  const start = json(await call("POST", "/v1/auth/step-up", { step: "start" }, { cookie }));
  const finish = json(
    await call(
      "POST",
      "/v1/auth/step-up",
      { step: "finish", credential: key.assert(start["options"] as { challenge: string }, ORIGIN) },
      { cookie },
    ),
  );
  return { cookie, "x-step-up": finish["step_up_token"] as string };
}

const give = async (membershipId: string, sections: string[]) =>
  call(
    "PUT",
    venue(`/team/${membershipId}/admin-sections`),
    { sections },
    await stepUp(ownerCookie, ownerKey),
  );

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  owner = new pg.Pool({ connectionString: db.url, max: 2 });
  rw = appPool(db.url);
  await owner.query("update users set email = $2 where id = $1", [v.ownerA, OWNER_EMAIL]);
  await owner.query("update users set email = $2 where id = $1", [v.bartenderA, MAYA_EMAIL]);
  maya = (
    await owner.query<{ id: string }>(
      "select id from memberships where venue_id = $1 and user_id = $2",
      [v.venueA, v.bartenderA],
    )
  ).rows[0]!.id;
  const au = await owner.query<{ id: string }>(
    "insert into users (name, email) values ('Andy C.', $1) returning id",
    [ANDY_EMAIL],
  );
  andy = (
    await owner.query<{ id: string }>(
      "insert into memberships (venue_id, user_id, role, status, pin_digits, locale) values ($1, $2, 'manager', 'active', 6, 'en') returning id",
      [v.venueA, au.rows[0]!.id],
    )
  ).rows[0]!.id;
  const bu = await owner.query<{ id: string }>(
    "insert into users (name) values ('Sam B.') returning id",
  );
  staffB = (
    await owner.query<{ id: string }>(
      "insert into memberships (venue_id, user_id, role, status, pin_digits, locale) values ($1, $2, 'bartender', 'active', 4, 'en') returning id",
      [v.venueB, bu.rows[0]!.id],
    )
  ).rows[0]!.id;
  const config = loadConfig({
    WEST4_ENV: "local",
    DATABASE_URL: db.url,
    APP_DATABASE_URL: db.url,
    AUTH_SECRET_KEY: KEY,
    WEBAUTHN_RP_ID: "localhost",
    WEBAUTHN_ORIGINS: ORIGIN,
    STAFF_APP_URL: ORIGIN,
  });
  app = buildApp({ config, clock, moduleCacheMs: 0 });
  await app.ready();
  ownerCookie = await enrol(OWNER_EMAIL, ownerKey);
  andyCookie = await enrol(ANDY_EMAIL, andyKey);
});

afterAll(async () => {
  await app.close();
  await rw.end();
  await owner.end();
  await db.drop();
});

describe("P-10 · Can also open", () => {
  it("before any grant, a bartender has no passkey sign-in: no code goes to her email", async () => {
    expect(
      (await call("POST", "/v1/auth/enroll", { step: "start", email: MAYA_EMAIL })).statusCode,
    ).toBe(200);
    const sent = await owner.query(
      "select 1 from jobs where kind = 'email.send' and payload->>'to' = $1",
      [MAYA_EMAIL],
    );
    expect(sent.rowCount).toBe(0);
  });

  it("a manager can't give a section, nor can the owner without the passkey again", async () => {
    const byAndy = await call(
      "PUT",
      venue(`/team/${maya}/admin-sections`),
      { sections: ["licenses"] },
      await stepUp(andyCookie, andyKey),
    );
    expect(byAndy.statusCode).toBe(403);
    const noStepUp = await call(
      "PUT",
      venue(`/team/${maya}/admin-sections`),
      { sections: ["licenses"] },
      { cookie: ownerCookie },
    );
    expect(json(noStepUp).error?.code).toBe("step_up_required");
    const list = await call("GET", venue("/admin-sections"), undefined, { cookie: andyCookie });
    expect(list.statusCode).toBe(403);
  });

  it("never Payments, Team or Console; an owner's or manager's role already has them; venue B's person isn't found", async () => {
    for (const s of ["payments", "team", "console", "venue"])
      expect((await give(maya, [s])).statusCode, s).toBe(400);
    const toAndy = await give(andy, ["licenses"]);
    expect(toAndy.statusCode).toBe(400);
    expect(json(toAndy).error?.details?.["reason"]).toBe("role_has_them");
    expect((await give(staffB, ["licenses"])).statusCode).toBe(404);
  });

  it("the owner gives Maya Licenses: its routes open in her passkey session, read and write", async () => {
    const r = await give(maya, ["licenses"]);
    expect(r.statusCode, r.body).toBe(200);
    expect(json(r)["sections"]).toEqual(["licenses"]);
    // With a grant she signs in the way a manager does: her email, then her own passkey.
    await enrol(MAYA_EMAIL, mayaKey);
    // A grant turns two-step sign-in on for her, as a manager's role does; she signs in with the passkey.
    const mfa = await owner.query<{ mfa_required: boolean }>(
      "select mfa_required from users where id = $1",
      [v.bartenderA],
    );
    expect(mfa.rows[0]!.mfa_required).toBe(true);
    const start = json(
      await call("POST", "/v1/auth/login", { step: "start", method: "passkey", email: MAYA_EMAIL }),
    );
    const login = await call("POST", "/v1/auth/login", {
      step: "finish",
      method: "passkey",
      email: MAYA_EMAIL,
      credential: mayaKey.assert(start["options"] as { challenge: string }, ORIGIN),
      client: "web",
    });
    expect(login.statusCode, login.body).toBe(200);
    mayaCookie = cookieOf(login);
    const me = json(await call("GET", "/v1/auth/me", undefined, { cookie: mayaCookie }));
    const mine = (me["memberships"] as { venue_id: string; admin_sections: string[] }[]).find(
      (m) => m.venue_id === v.venueA,
    );
    expect(mine?.admin_sections).toEqual(["licenses"]);
    expect(
      (await call("GET", venue("/licenses"), undefined, { cookie: mayaCookie })).statusCode,
    ).toBe(200);
    const made = await call(
      "POST",
      venue("/licenses"),
      { kind: "ascap", number: "P10-ASCAP" },
      { cookie: mayaCookie },
    );
    expect(made.statusCode, made.body).toBe(201);
    // Every Admin's rule-pack notice reads for anyone with a grant.
    expect(
      (await call("GET", venue("/rule-pack"), undefined, { cookie: mayaCookie })).statusCode,
    ).not.toBe(403);
    // The owner's list shows it.
    const list = json(
      await call("GET", venue("/admin-sections"), undefined, { cookie: ownerCookie }),
    );
    expect(list["people"]).toEqual([{ membership_id: maya, sections: ["licenses"] }]);
  });

  it("a section she wasn't given, Team, settings outside Licenses, the reports and the glance stay refused", async () => {
    const as = { cookie: mayaCookie };
    expect((await call("GET", venue("/settings/hours"), undefined, as)).statusCode).toBe(403);
    expect(
      (await call("PUT", venue("/settings/alerts"), { value: { roomEndingMin: 10 } }, as))
        .statusCode,
    ).toBe(403);
    expect((await call("PUT", venue("/settings/pos"), { value: {} }, as)).statusCode).toBe(403);
    expect((await call("GET", venue("/team"), undefined, as)).statusCode).toBe(403);
    expect((await call("GET", venue("/permissions"), undefined, as)).statusCode).toBe(403);
    expect((await call("GET", venue("/payments"), undefined, as)).statusCode).toBe(403);
    expect((await call("GET", venue("/support-grants"), undefined, as)).statusCode).toBe(403);
    expect(
      (await call("POST", venue("/closures"), { date: "2026-10-01", closed: true }, as)).statusCode,
    ).toBe(403);
    // P-09's staff actions and P-12's glance follow the role, not the grant.
    expect((await call("GET", venue("/reports/staff-actions"), undefined, as)).statusCode).toBe(
      403,
    );
    expect((await call("GET", venue("/glance"), undefined, as)).statusCode).toBe(403);
  });

  it("each grant and each one taken back is in the audit log, and taking it back closes it at once", async () => {
    const r = await give(maya, []);
    expect(r.statusCode, r.body).toBe(200);
    expect(json(r)["sections"]).toEqual([]);
    expect(
      (await call("GET", venue("/licenses"), undefined, { cookie: mayaCookie })).statusCode,
    ).toBe(403);
    const audit = await owner.query<{ action: string; actor: string }>(
      `select action, actor from audit_log
        where venue_id = $1 and target like 'admin_section_grants/%' order by id`,
      [v.venueA],
    );
    expect(audit.rows.map((a) => a.action)).toEqual([
      "admin_section_grants.insert",
      "admin_section_grants.update",
    ]);
    expect(audit.rows.every((a) => a.actor === v.ownerA)).toBe(true);
  });

  it("app_rw adds a grant and stamps it taken back, never deletes one, and never sees venue B's", async () => {
    const id = await withVenue(
      rw,
      { venueId: v.venueA, userId: v.ownerA, requestId: "p10" },
      async (c) => {
        const ins = await c.query<{ id: string }>(
          `insert into admin_section_grants (venue_id, membership_id, section, granted_by, granted_at)
         values ($1, $2, 'menu', $3, now()) returning id`,
          [v.venueA, maya, v.ownerA],
        );
        await c.query(
          "update admin_section_grants set revoked_by = $2, revoked_at = now() where id = $1",
          [ins.rows[0]!.id, v.ownerA],
        );
        return ins.rows[0]!.id;
      },
    );
    await expect(
      withVenue(rw, { venueId: v.venueA, userId: v.ownerA, requestId: "p10" }, (c) =>
        c.query("delete from admin_section_grants where id = $1", [id]),
      ),
    ).rejects.toThrow(/permission denied/);
    const fromB = await withVenue(rw, { venueId: v.venueB, requestId: "p10" }, (c) =>
      c.query("select 1 from admin_section_grants where id = $1", [id]),
    );
    expect(fromB.rowCount).toBe(0);
  });
});
