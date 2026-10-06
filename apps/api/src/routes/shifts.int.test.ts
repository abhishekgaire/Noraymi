import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed, managerOnDuty, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { shiftMinutes } from "@west4/rules";
import { FrozenClock, SEED_NOW } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal, StaffRole } from "../http/principal.js";

/** M7-01: the time clock on the demo seed at 10:41 PM. */
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
let who: Principal;
const clock = new FrozenClock(SEED_NOW);

const as = (slug: string, role: StaffRole): Principal => ({
  kind: "user",
  userId: ids[slug]!,
  session: "pin",
  memberships: [{ venueId, membershipId: ids[`${slug}.membership`]!, role }],
});

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  pool = appPool(db.url);
  ids = Object.fromEntries(
    (
      await raw.query<{ slug: string; id: string }>(
        "select slug, row_id as id from seed_ids where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.slug, r.id]),
  );
  who = as("maya", "bartender");
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [async () => who],
    moduleCacheMs: 0,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await raw.end();
  await db.drop();
});

const call = (method: "GET" | "POST", path: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/v1/venues/${venueId}${path}`,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

interface Team {
  me: { duties: string[]; shift: { started_at: string; break_minutes: number } | null };
  team: {
    name: string;
    shift: { started_at: string; punches: { kind: "clock_in"; at: string }[] } | null;
  }[];
}

describe("the time clock (M7-01)", () => {
  it("at 10:41 PM: Maya on since 4:00 PM (6h 41m), Andy since 6:00 PM, Diego since 7:00 PM, Abhishek not on shift", async () => {
    const answer = (await call("GET", "/shifts")).json() as Team;
    const worked = (name: string) => {
      const s = answer.team.find((t) => t.name === name)!.shift;
      return s ? shiftMinutes(s.punches, SEED_NOW).workedMinutes : null;
    };
    expect(worked("Maya S.")).toBe(6 * 60 + 41);
    expect(worked("Andy C.")).toBe(4 * 60 + 41);
    expect(worked("Diego R.")).toBe(3 * 60 + 41);
    expect(worked("Abhishek G.")).toBeNull();
    // The shared screen's tiles carry the same.
    who = {
      kind: "device",
      deviceId: ids["bar_computer"] ?? venueId,
      venueId,
      deviceKind: "bar_computer",
    };
    const tiles = (await call("GET", "/team/tiles")).json() as {
      tiles: { name: string; shift: { started_at: string } | null }[];
    };
    expect(tiles.tiles.find((t) => t.name === "Maya S.")!.shift!.started_at).toBe(
      "2026-09-25T20:00:00Z",
    );
    expect(tiles.tiles.find((t) => t.name === "Abhishek G.")!.shift).toBeNull();
    who = as("maya", "bartender");
  });

  it("refuses a clock-in without a duty, and offers Manager only to owners and managers", async () => {
    who = as("abhishek", "owner");
    expect(((await call("GET", "/shifts")).json() as Team).me.duties).toEqual([
      "bar",
      "front_desk",
      "runner",
      "manager",
    ]);
    const none = await call("POST", "/shifts/clock-in", {});
    expect(none.statusCode).toBe(400);
    expect(none.json().error.code).toBe("invalid_request");
    who = as("maya", "bartender");
    expect(((await call("GET", "/shifts")).json() as Team).me.duties).toEqual([
      "bar",
      "front_desk",
      "runner",
    ]);
    const manager = await call("POST", "/shifts/clock-in", { duty: "manager" });
    expect(manager.statusCode).toBe(403);
  });

  it("refuses a second clock-in while a shift is open", async () => {
    const again = await call("POST", "/shifts/clock-in", { duty: "bar" });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.details.refusal).toBe("already_on");
  });

  it("Maya's break shows on every bar screen until she ends it, and adds to break_minutes", async () => {
    const start = await call("POST", "/shifts/break", { action: "start" });
    expect(start.statusCode).toBe(200);
    // Diego, signed in on another bar computer, sees "Maya · on break".
    who = as("diego", "front_desk");
    const terminal = (await call("GET", "/pos/terminal")).json() as {
      on_break: boolean;
      breaks: { name: string }[];
    };
    expect(terminal).toMatchObject({ on_break: false, breaks: [{ name: "Maya S." }] });
    who = as("maya", "bartender");
    expect((await call("POST", "/shifts/break", { action: "start" })).statusCode).toBe(409);
    clock.set(SEED_NOW.add({ minutes: 15 }));
    const end = await call("POST", "/shifts/break", { action: "end" });
    expect(end.json().shift.break_minutes).toBe(15);
    const row = await raw.query<{ break_minutes: number }>(
      "select break_minutes from shifts where membership_id = $1 and ended_at is null",
      [ids["maya.membership"]],
    );
    expect(row.rows[0]!.break_minutes).toBe(15);
    expect(((await call("GET", "/pos/terminal")).json() as { breaks: unknown[] }).breaks).toEqual(
      [],
    );
    const events = await raw.query("select 1 from venue_events where type = 'shift.updated'");
    expect(events.rowCount).toBeGreaterThan(0);
  });

  it("Maya's fix panel reads $63 left this shift; a new shift starts her at $75", async () => {
    expect((await call("GET", "/reason-only")).json()).toMatchObject({ left_cents: 6300 });
    // Her clock-out checklist (M7-11) cleared: her tabs to Diego, her cash tips declared.
    await raw.query("update tabs set owner_id = $1 where owner_id = $2", [
      ids["diego"],
      ids["maya"],
    ]);
    await raw.query(
      "update shifts set cash_tips_declared_cents = 0, cash_tips_declared_at = now() where membership_id = $1 and ended_at is null",
      [ids["maya.membership"]],
    );
    const out = await call("POST", "/shifts/clock-out");
    expect(out.statusCode).toBe(200);
    expect(out.json().shift.business_date).toBe("2026-09-25");
    expect((await call("POST", "/shifts/clock-out")).statusCode).toBe(409);
    // Off the clock, the business date is the cautious window.
    expect((await call("GET", "/reason-only")).json()).toMatchObject({ left_cents: 6300 });
    const back = await call("POST", "/shifts/clock-in", { duty: "bar" });
    expect(back.statusCode).toBe(201);
    expect((await call("GET", "/reason-only")).json()).toMatchObject({ left_cents: 7500 });
    const shifts = await raw.query<{ ended_at: Date | null }>(
      "select ended_at from shifts where membership_id = $1 order by started_at, created_at",
      [ids["maya.membership"]],
    );
    expect(shifts.rows.map((r) => r.ended_at === null)).toEqual([false, true]);
  });

  it("Andy's open Manager shift makes him the manager on duty; the first one clocked in stays until a handover", async () => {
    const onDuty = () => withVenue(pool, { venueId }, (c) => managerOnDuty(c, venueId));
    expect(await onDuty()).toBe(ids["andy"]);
    const diegoVoid = await raw.query<{ routed_to: string }>(
      "select routed_to from approvals where status = 'pending' and kind = 'void'",
    );
    expect(diegoVoid.rows.map((r) => r.routed_to)).toContain(ids["andy"]);
    who = as("abhishek", "owner");
    expect((await call("POST", "/shifts/clock-in", { duty: "manager" })).statusCode).toBe(201);
    expect(await onDuty()).toBe(ids["andy"]);
    who = as("andy", "manager");
    // With another manager on, Andy's checklist asks him to hand the drawers over first (M7-11).
    const asked = await call("POST", "/shifts/clock-out");
    expect(asked.statusCode).toBe(409);
    expect(asked.json().error.details.items).toEqual([{ kind: "drawer_handover" }]);
    await raw.query("update drawer_sessions set responsible_id = $1 where state = 'open'", [
      ids["abhishek"],
    ]);
    expect((await call("POST", "/shifts/clock-out")).statusCode).toBe(200);
    expect(await onDuty()).toBe(ids["abhishek"]);
    who = as("abhishek", "owner");
    await call("POST", "/shifts/clock-out");
    expect(await onDuty()).toBeNull();
  });

  it("with Team, time clock & tips off, every time clock route answers 404 module_off", async () => {
    await raw.query("update venue_modules set state = 'off' where module_id = 'team'");
    try {
      for (const [method, path, body] of [
        ["GET", "/shifts", undefined],
        ["POST", "/shifts/clock-in", { duty: "bar" }],
        ["POST", "/shifts/break", { action: "start" }],
        ["POST", "/shifts/clock-out", undefined],
      ] as const) {
        const r = await call(method, path, body);
        expect(r.statusCode).toBe(404);
        expect(r.json().error.code).toBe("module_off");
      }
      expect(((await call("GET", "/pos/terminal")).json() as { breaks: unknown[] }).breaks).toEqual(
        [],
      );
    } finally {
      await raw.query("update venue_modules set state = 'on' where module_id = 'team'");
    }
  });
});
