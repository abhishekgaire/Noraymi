import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed, nextCheckNumber, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { openRoomCheck } from "../rooms/checks.js";

/**
 * M2-08 acceptance on the demo seed: Room 9's #1042 and its $158.00 of
 * drinks; check numbers taken concurrently never repeat; and app_rw can't
 * change or delete a line.
 */
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);

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
  const m = (
    await raw.query<{ id: string; user_id: string }>(
      "select id, user_id from memberships where venue_id = $1 and role = 'front_desk'",
      [venueId],
    )
  ).rows[0]!;
  const diego: Principal = {
    kind: "user",
    userId: m.user_id,
    session: "pin",
    memberships: [{ venueId, membershipId: m.id, role: "front_desk" }],
  };
  const config = loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url });
  app = buildApp({ config, clock, authenticators: [async () => diego], moduleCacheMs: 0 });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await raw.end();
  await db.drop();
});

describe("checks", () => {
  it("Room 9's check is #1042, its three drink lines add up to $158.00, and the tab so far is $480.00", async () => {
    const r = await app.inject({
      method: "GET",
      url: `/v1/venues/${venueId}/checks/${ids["chk_room9"]}`,
    });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as {
      check: { number: number; label: string; kind: string; status: string; version: number };
      lines: { kind: string; tax_category: string; amount_cents: number }[];
      lines_cents: number;
      room_time_cents: number;
      tab_so_far_cents: number;
    };
    expect(body.check).toMatchObject({
      number: 1042,
      label: "#1042",
      kind: "room",
      status: "open",
      version: 3,
    });
    expect(body.lines).toHaveLength(3);
    expect(body.lines.every((l) => l.kind === "item" && l.tax_category === "drink")).toBe(true);
    expect(body.lines_cents).toBe(15800);
    expect(body.room_time_cents).toBe(32200);
    expect(body.tab_so_far_cents).toBe(48000);
    const session = await raw.query<{ check_id: string }>(
      "select check_id from room_sessions where id = $1",
      [ids["sess_room9"]],
    );
    expect(session.rows[0]!.check_id).toBe(ids["chk_room9"]);
  });

  it("each new check takes the next number; numbers taken at the same moment differ, and none is used twice", async () => {
    const numbers = await Promise.all(
      Array.from({ length: 20 }, () => nextCheckNumber(pool, venueId)),
    );
    expect(new Set(numbers).size).toBe(20);
    // In order after the seed's checks, with no gaps; only #1042 is a fixed number (M4-10).
    expect(Math.min(...numbers)).toBeGreaterThan(1042);
    expect(Math.max(...numbers) - Math.min(...numbers)).toBe(19);
    // Two check-ins at once: two checks, two numbers.
    const opened = await Promise.all(
      ["sess_room1", "sess_room3"].map((s) =>
        openRoomCheck(pool, {
          venueId,
          sessionId: ids[s]!,
          bookingId: null,
          businessDate: "2026-09-25",
          openedBy: ids["diego"]!,
          now: SEED_NOW,
        }),
      ),
    );
    // After the seed's 13 checks, its three paper slips' (#1054 to #1056, M6-09) and the ones above.
    expect(opened.map((o) => o.number).sort()).toEqual([1077, 1078]);
    // The database refuses a number used twice.
    await expect(
      withVenue(pool, { venueId }, (c) =>
        c.query(
          "insert into checks (venue_id, number, kind, business_date, opened_by) values ($1, 1042, 'bar', '2026-09-25', $2)",
          [venueId, ids["maya"]],
        ),
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("app_rw can't change a line's amount_cents or delete a line", async () => {
    await expect(
      withVenue(pool, { venueId }, (c) =>
        c.query("update check_lines set amount_cents = 1 where check_id = $1", [ids["chk_room9"]]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withVenue(pool, { venueId }, (c) =>
        c.query("delete from check_lines where check_id = $1", [ids["chk_room9"]]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withVenue(pool, { venueId }, (c) =>
        c.query("update checks set number = 1 where id = $1", [ids["chk_room9"]]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    const still = await raw.query<{ total: string }>(
      "select sum(amount_cents)::text as total from check_lines where check_id = $1",
      [ids["chk_room9"]],
    );
    expect(still.rows[0]!.total).toBe("15800");
  });
});
