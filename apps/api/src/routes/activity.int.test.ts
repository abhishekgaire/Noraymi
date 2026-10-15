import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestDatabase, seedTwoVenues, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import type { ActivityRow } from "./activity.js";

/**
 * P-14: Admin → Activity log and About. The log reads the venue's own audit rows as app_rw (row-level
 * security forced), newest first, filtered by person, kind and business date, with personal data
 * masked and secrets never sent; it's the owner's (managers by P-10). About is owners' and managers'.
 */
let db: TestDatabase;
let owner: pg.Client;
let app: FastifyInstance;
let v: Awaited<ReturnType<typeof seedTwoVenues>>;
let managerA = "";
let current: Principal;
const clock = new SimulatedClock(SEED_NOW);
const user = (
  userId: string,
  venueId: string,
  role: string,
  session: "passkey" | "pin" = "passkey",
): Principal => ({
  kind: "user",
  userId,
  session,
  memberships: [{ venueId, membershipId: "m", role }],
});
const get = (url: string) => app.inject({ method: "GET", url });
const activity = async (query = "", venue = v.venueA) => {
  const r = await get(`/v1/venues/${venue}/activity${query}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json<{
    rows: ActivityRow[];
    next_before: string | null;
    people: { user_id: string; name: string }[];
    kinds: string[];
  }>();
};

/** Writes as `actor` at `venueId`, so the trigger stamps the actor on the audit row. */
async function as(actor: string, venueId: string, sql: string, args: unknown[]) {
  await owner.query("begin");
  await owner.query("select set_config('app.user_id', $1, true)", [actor]);
  await owner.query("select set_config('app.venue_id', $1, true)", [venueId]);
  await owner.query(sql, args);
  await owner.query("commit");
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  owner = new pg.Client({ connectionString: db.url });
  await owner.connect();
  const u = await owner.query<{ id: string }>(
    "insert into users (name) values ('Andy C.') returning id",
  );
  managerA = u.rows[0]!.id;
  await owner.query(
    "insert into memberships (venue_id, user_id, role, status) values ($1, $2, 'manager', 'active')",
    [v.venueA, managerA],
  );
  await as(
    v.ownerA,
    v.venueA,
    "insert into guests (venue_id, name, phone_e164, email) values ($1, 'Marcus Thompson', '+12125550123', 'marcus@example.com')",
    [v.venueA],
  );
  await as(
    managerA,
    v.venueA,
    "update memberships set pin_verifier = 'scrypt$secret-verifier' where venue_id = $1 and user_id = $2",
    [v.venueA, managerA],
  );
  await as(
    v.ownerB,
    v.venueB,
    "insert into guests (venue_id, name, phone_e164) values ($1, 'Only At B', '+12125550999')",
    [v.venueB],
  );
  current = user(v.ownerA, v.venueA, "owner");
  app = buildApp({
    config: loadConfig({
      WEST4_ENV: "local",
      DATABASE_URL: db.url,
      // As the API runs: app_rw, row-level security forced.
      APP_DATABASE_URL: db.url.replace("//west4:west4@", "//app_rw:app_rw@"),
    }),
    clock,
    authenticators: [async () => current],
    moduleCacheMs: 0,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await owner.end();
  await db.drop();
});

describe("Admin → Activity log", () => {
  it("lists only the venue's own rows, newest first, with names", async () => {
    current = user(v.ownerA, v.venueA, "owner");
    const a = await activity();
    expect(a.rows.length).toBeGreaterThan(0);
    const ids = a.rows.map((r) => Number(r.id));
    expect(ids).toEqual([...ids].sort((x, y) => y - x));
    const venueBRows = (
      await owner.query<{ id: string }>(
        "select id::text as id from audit_log where venue_id = $1",
        [v.venueB],
      )
    ).rows.map((r) => r.id);
    expect(venueBRows.length).toBeGreaterThan(0);
    for (const r of a.rows) expect(venueBRows).not.toContain(r.id);
    expect(JSON.stringify(a)).not.toContain("Only At B");
    expect(JSON.stringify(a)).not.toContain("0999");
    const guest = a.rows.find((r) => r.kind === "guests")!;
    expect(guest.actor).toEqual({ user_id: v.ownerA, name: "Owner A" });
    expect(a.kinds).toContain("guests");
    expect(a.people.map((p) => p.name)).toContain("Andy C.");
    expect(a.people.map((p) => p.name)).not.toContain("Owner B");
  });

  it("keeps masked fields masked: no contact details, no PIN verifier, guest names as initials", async () => {
    const a = await activity();
    const body = JSON.stringify(a);
    for (const leak of ["marcus@example.com", "+12125550123", "Marcus Thompson", "secret-verifier"])
      expect(body).not.toContain(leak);
    const guest = a.rows.find((r) => r.kind === "guests" && r.op === "insert")!;
    expect(guest.changes.find((c) => c.field === "name")).toMatchObject({ new: "M. T." });
    expect(guest.changes.find((c) => c.field === "phone_e164")).toMatchObject({ hidden: true });
    expect(guest.changes.find((c) => c.field === "email")).toMatchObject({ hidden: true });
    const pin = a.rows.find((r) => r.kind === "memberships" && r.op === "update")!;
    expect(pin.changes).toEqual([{ field: "pin_verifier", hidden: true, old: null, new: null }]);
  });

  it("filters by person, kind and business date, and pages by id", async () => {
    const byAndy = await activity(`?person=${managerA}`);
    expect(byAndy.rows.length).toBeGreaterThan(0);
    expect(byAndy.rows.every((r) => r.actor?.user_id === managerA)).toBe(true);
    const system = await activity("?person=system");
    expect(system.rows.every((r) => r.actor === null)).toBe(true);
    const guests = await activity("?kind=guests");
    expect(guests.rows.map((r) => r.kind)).toEqual(["guests"]);
    const today = guests.rows[0]!.business_date;
    expect((await activity(`?kind=guests&from=${today}&to=${today}`)).rows).toHaveLength(1);
    expect((await activity(`?kind=guests&from=2001-01-01&to=2001-01-02`)).rows).toHaveLength(0);
    const all = await activity();
    const older = await activity(`?before=${all.rows[0]!.id}`);
    expect(older.rows.every((r) => Number(r.id) < Number(all.rows[0]!.id))).toBe(true);
    for (const bad of ["?person=x", "?kind=Drop;", "?from=yesterday", "?before=1e3"])
      expect((await get(`/v1/venues/${v.venueA}/activity${bad}`)).statusCode).toBe(400);
  });

  it("is the owner's: a manager, a bartender, a PIN session and venue B's owner are refused", async () => {
    current = user(managerA, v.venueA, "manager");
    expect((await get(`/v1/venues/${v.venueA}/activity`)).statusCode).toBe(403);
    current = user(v.bartenderA, v.venueA, "bartender");
    expect((await get(`/v1/venues/${v.venueA}/activity`)).statusCode).toBe(403);
    current = user(v.ownerA, v.venueA, "owner", "pin");
    expect((await get(`/v1/venues/${v.venueA}/activity`)).statusCode).toBe(403);
    current = user(v.ownerB, v.venueB, "owner");
    expect([403, 404]).toContain((await get(`/v1/venues/${v.venueA}/activity`)).statusCode);
    // Venue B's owner reads venue B's log alone.
    const b = await activity("", v.venueB);
    expect(JSON.stringify(b)).not.toContain("Owner A");
    expect(b.rows.some((r) => r.kind === "guests")).toBe(true);
    current = user(v.ownerA, v.venueA, "owner");
  });
});

describe("Admin → About", () => {
  it("shows the venue's id and name, the server's version and no invented contact", async () => {
    current = user(managerA, v.venueA, "manager");
    const r = await get(`/v1/venues/${v.venueA}/about`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      venue_id: v.venueA,
      venue_name: "Venue A",
      server_version: expect.any(String),
      support: { email: process.env["SUPPORT_EMAIL"]?.trim() || null },
    });
    current = user(v.bartenderA, v.venueA, "bartender");
    expect((await get(`/v1/venues/${v.venueA}/about`)).statusCode).toBe(403);
    current = user(v.ownerB, v.venueB, "owner");
    expect([403, 404]).toContain((await get(`/v1/venues/${v.venueA}/about`)).statusCode);
  });
});
