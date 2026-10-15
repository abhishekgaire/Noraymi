import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, Temporal, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/**
 * A quick sale after the 4 AM stop, straight through the API (CLAUDE.md · Alcohol rules are
 * enforced on the server): the beer is refused as `409 alcohol_closed`, as every other alcohol route
 * answers; the refusal is logged on no check (the sale's own check was rolled back with it); and no
 * quick check is left behind. A room started at that hour on a package with a beer in it is the
 * same: its session and check are made in the refused transaction. The API connects as app_rw,
 * behind the venue wall.
 */
let db: TestDatabase;
let owner: pg.Pool;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
let who: Principal;
let maya: Principal;
let front: Principal & { userId: string };
const clock = new FrozenClock(SEED_NOW);
// 4:05 AM in New York on Sat Sep 26 (EDT): still business date Fri Sep 25, past the alcohol stop.
const AFTER_FOUR = Temporal.Instant.from("2026-09-26T08:05:00Z");
let n = 0;
const sell = (lines: { variant_id: string; qty: number }[]) =>
  app.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/quick-sales`,
    payload: { client_order_id: `fix4am-${++n}`, lines },
  });
const v = (item: string) => ids[`menu_${item}_regular`]!;
const roomChecks = async () =>
  Number(
    (await owner.query<{ n: string }>("select count(*) as n from checks where kind = 'room'"))
      .rows[0]!.n,
  );
const quickChecks = async () =>
  Number(
    (await owner.query<{ n: string }>("select count(*) as n from checks where kind = 'quick'"))
      .rows[0]!.n,
  );

/** The app's own connection string, switched to app_rw on connect (as the API runs in production). */
function asAppRw(url: string) {
  const u = new URL(url);
  u.searchParams.set("options", "-c role=app_rw");
  return u.toString();
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  const key = generateSigningKey().privateKeyPem;
  for (const pack of [newYorkCounty, newYorkCountyTaxed])
    await publishRulePack(owner, {
      pack,
      effectiveOn: "2026-09-01",
      approvedBy: ["A", "B"],
      privateKeyPem: key,
    });
  ids = Object.fromEntries(
    (
      await owner.query<{ slug: string; id: string }>("select slug, row_id as id from seed_ids")
    ).rows.map((r) => [r.slug, r.id]),
  );
  maya = {
    kind: "user",
    userId: ids["maya"]!,
    session: "pin",
    memberships: [{ venueId, membershipId: ids["maya.membership"]!, role: "bartender" }],
  };
  who = maya;
  const fd = (
    await owner.query<{ id: string; user_id: string }>(
      "select id, user_id from memberships where venue_id = $1 and role = 'front_desk'",
      [venueId],
    )
  ).rows[0]!;
  front = {
    kind: "user",
    userId: fd.user_id,
    session: "pin",
    memberships: [{ venueId, membershipId: fd.id, role: "front_desk" }],
  };
  const appUrl = asAppRw(db.url);
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: appUrl }),
    clock,
    moduleCacheMs: 0,
    authenticators: [async () => who],
  });
  await app.ready();
  // The app's connections really are app_rw.
  const probe = new pg.Pool({ connectionString: appUrl });
  expect((await probe.query<{ r: string }>("select current_user as r")).rows[0]!.r).toBe("app_rw");
  await probe.end();
});

afterAll(async () => {
  await app.close();
  await owner.end();
  await db.drop();
});

describe("Quick sale after the 4 AM stop", () => {
  it("before 4 AM the beer sells (the route works as app_rw)", async () => {
    const r = await sell([{ variant_id: v("modelo"), qty: 1 }]);
    expect(r.statusCode, r.body).toBe(201);
  });

  it("at 4:05 AM a beer is refused 409 alcohol_closed, logged on no check, and no check is left", async () => {
    const checksBefore = await quickChecks();
    const logged = async () =>
      (
        await owner.query<{ check_id: string | null; order_id: string | null; item: string }>(
          `select check_id, order_id, item from alcohol_refusals
            where venue_id = $1 and reason = 'window_closed' and refused_by = $2 and at = $3`,
          [venueId, ids["maya"], AFTER_FOUR.toString()],
        )
      ).rows;
    clock.set(AFTER_FOUR);
    try {
      const r = await sell([{ variant_id: v("modelo"), qty: 1 }]);
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().error).toMatchObject({
        code: "alcohol_closed",
        details: { reason: "window_closed" },
      });
      const rows = await logged();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ check_id: null, order_id: null });
      expect(await quickChecks()).toBe(checksBefore);
    } finally {
      clock.set(SEED_NOW);
    }
  });

  it("at 4:05 AM a room started on a package with a beer is refused the same way, and seats nobody", async () => {
    const item = (
      await owner.query<{ item_id: string }>("select item_id from menu_variants where id = $1", [
        v("modelo"),
      ])
    ).rows[0]!.item_id;
    const pkg = (
      await owner.query<{ id: string }>(
        `insert into packages (venue_id, name, price_cents, contents, minutes, checked_pack_version)
           values ($1, 'fix4am Beer hour', 4000, $2, 60, 'unchecked') returning id`,
        [venueId, JSON.stringify([{ item_id: item, qty: 1 }])],
      )
    ).rows[0]!.id;
    const sessions = async () =>
      Number(
        (await owner.query<{ n: string }>("select count(*) as n from room_sessions")).rows[0]!.n,
      );
    const before = { sessions: await sessions(), checks: await roomChecks() };
    who = front;
    clock.set(AFTER_FOUR);
    try {
      const board = (
        await app.inject({ method: "GET", url: `/v1/venues/${venueId}/board` })
      ).json() as {
        rooms: { room_id: string; free_now: boolean; state: string; session: object | null }[];
      };
      const room = board.rooms.find((x) => x.free_now && x.state === "available" && !x.session);
      expect(room, "a free room").toBeDefined();
      const r = await app.inject({
        method: "POST",
        url: `/v1/venues/${venueId}/rooms/${room!.room_id}/sessions`,
        payload: { party_size: 2, ids_checked: 2, minutes: 60, package_id: pkg },
      });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().error).toMatchObject({ code: "alcohol_closed" });
      const logged = await owner.query(
        `select session_id, check_id from alcohol_refusals
          where venue_id = $1 and reason = 'window_closed' and refused_by = $2 and at = $3`,
        [venueId, front.userId, AFTER_FOUR.toString()],
      );
      expect(logged.rows).toEqual([{ session_id: null, check_id: null }]);
      expect({ sessions: await sessions(), checks: await roomChecks() }).toEqual(before);
    } finally {
      clock.set(SEED_NOW);
      who = maya;
    }
  });
});
