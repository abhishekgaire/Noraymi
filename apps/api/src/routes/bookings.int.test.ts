import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/**
 * M2-06 acceptance on the demo seed: a staff booking gets a real room and
 * its deposit; the past and a taken room are refused; the grid on both
 * daylight-saving nights; the seed's 11 bookings; reassigning, cancelling,
 * and a room switched off moving its future bookings.
 */
let db: TestDatabase;
let raw: pg.Client;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
const json = (r: { body: string }) =>
  JSON.parse(r.body) as Record<string, unknown> & { error?: { code: string; message: string } };
const call = (method: "GET" | "POST" | "PATCH", path: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/v1/venues/${venueId}${path}`,
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
const book = (over: Record<string, unknown> = {}) =>
  call("POST", "/bookings", {
    guest: { name: "Lena V.", phone_e164: "+12125550199" },
    party_size: 6,
    business_date: "2026-09-26",
    time: "21:30",
    hours: 2,
    ...over,
  });

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
  const m = (
    await raw.query<{ id: string; user_id: string }>(
      "select id, user_id from memberships where venue_id = $1 and role = 'front_desk'",
      [venueId],
    )
  ).rows[0]!;
  // Diego, the front desk, books in a PIN session: bookings are his work, not Admin's.
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
  await raw.end();
  await db.drop();
});

describe("staff bookings", () => {
  let lena = "";

  it("6 on Sat Sep 26 at 9:30 PM for 2 hours: a room from Rooms 1–5 (never Room 4), a $60.00 deposit, pending", async () => {
    const r = await book();
    expect(r.statusCode, r.body).toBe(201);
    const b = json(r)["booking"] as Record<string, unknown>;
    expect(b).toMatchObject({
      party_size: 6,
      size_tier: "small",
      deposit_cents: 6000,
      status: "pending",
      source: "staff",
      business_date: "2026-09-26",
      guest_name: "Lena V.",
    });
    expect(["Room 1", "Room 2", "Room 3", "Room 5"]).toContain(b["room_name"]);
    lena = b["id"] as string;
    const block = await raw.query<{ kind: string }>(
      "select kind from room_blocks where ref_id = $1",
      [lena],
    );
    expect(block.rows).toEqual([{ kind: "hold" }]);
  });

  it("tonight at 9:00 PM is refused (it's 10:41 PM), and so is the VIP room from 11:00 PM, Bianca L.'s until 12:30 AM", async () => {
    const past = await book({ business_date: "2026-09-25", time: "21:00" });
    expect(past.statusCode).toBe(400);
    expect(json(past).error?.message).toBe("that time has passed");
    const vip = await book({
      business_date: "2026-09-25",
      time: "23:00",
      party_size: 20,
      room_id: ids["room_vip"],
    });
    expect(vip.statusCode).toBe(409);
    expect(json(vip).error?.code).toBe("room_not_free");
    const outOfService = await book({ room_id: ids["room_4"], time: "20:00" });
    expect(json(outOfService).error?.code).toBe("room_not_free");
    expect((await book({ hours: 13 })).statusCode).toBe(400);
    expect((await book({ time: "21:15" })).statusCode).toBe(400); // not on the half-hour grid
    expect((await book({ time: "03:30", hours: 1 })).statusCode).toBe(400); // ends after the 4:00 AM close
  });

  it("the grid offers 1:00 AM EDT and 1:00 AM EST on Sat Oct 31, 2026, and a 2:30 AM start on Sat Mar 13, 2027 is refused", async () => {
    const grid = json(await call("GET", "/bookings/grid?business_date=2026-10-31"))[
      "slots"
    ] as Array<{ time: string; zone: string; offset: string }>;
    expect(grid.filter((s) => s.time === "01:00").map((s) => s.zone)).toEqual(["EDT", "EST"]);
    const est = await book({
      business_date: "2026-10-31",
      time: "01:00",
      offset: "-05:00",
      hours: 1,
      party_size: 4,
    });
    expect(est.statusCode, est.body).toBe(201);
    expect((json(est)["booking"] as { starts_at: string }).starts_at).toBe(
      "2026-11-01T06:00:00+00:00",
    );
    expect(
      json(await book({ business_date: "2026-10-31", time: "01:00", hours: 1, party_size: 4 }))
        .error?.message,
    ).toMatch(/happens twice/);
    const spring = await book({
      business_date: "2027-03-13",
      time: "02:30",
      hours: 1,
      party_size: 4,
    });
    expect(spring.statusCode).toBe(400);
    expect(json(spring).error?.message).toMatch(/doesn't exist/);
    const springGrid = json(await call("GET", "/bookings/grid?business_date=2027-03-13"))[
      "slots"
    ] as Array<{ time: string }>;
    expect(springGrid.map((s) => s.time)).not.toContain("02:30");
  });

  it("the seed's 11 bookings load with their rooms, deposits and statuses", async () => {
    const list = json(await call("GET", "/bookings?business_date=2026-09-25"))["bookings"] as Array<
      Record<string, unknown>
    >;
    expect(list).toHaveLength(11);
    const by = (name: string) => list.find((b) => b["guest_name"] === name)!;
    expect(by("Marcus T.")).toMatchObject({
      room_name: "Room 9",
      party_size: 12,
      deposit_cents: 12000,
      status: "checked_in",
    });
    expect(by("Sam O.")).toMatchObject({
      room_name: "Room 2",
      party_size: 3,
      deposit_cents: 4000,
      status: "confirmed",
      running_late_until: "2026-09-26T02:45:00+00:00",
    });
    expect(by("Bianca L.")).toMatchObject({
      room_name: "VIP room",
      party_size: 22,
      deposit_cents: 25000,
    });
    expect(list.filter((b) => b["status"] === "checked_in")).toHaveLength(7);
    expect(list.filter((b) => b["status"] === "confirmed")).toHaveLength(4);
  });

  it("staff reassign a room, change the party, and cancel; the room is free again", async () => {
    const before = json(await call("GET", `/bookings?business_date=2026-09-26`))[
      "bookings"
    ] as Array<{ id: string; room_id: string }>;
    const from = before.find((b) => b.id === lena)!.room_id;
    const to = [ids["room_1"], ids["room_2"], ids["room_3"], ids["room_5"]].find(
      (r) => r !== from,
    )!;
    const moved = await call("PATCH", `/bookings/${lena}`, { room_id: to });
    expect(moved.statusCode, moved.body).toBe(200);
    expect((json(moved)["booking"] as { room_id: string }).room_id).toBe(to);
    expect((await call("PATCH", `/bookings/${lena}`, { party_size: 9 })).statusCode).toBe(400); // a small room holds 6
    expect((await call("PATCH", `/bookings/${lena}`, { status: "cancelled" })).statusCode).toBe(
      200,
    );
    const block = await raw.query("select 1 from room_blocks where ref_id = $1", [lena]);
    expect(block.rowCount).toBe(0);
    expect((await call("PATCH", `/bookings/${lena}`, { party_size: 4 })).statusCode).toBe(400);
  });
});

describe("a room switched off moves its future bookings", () => {
  it("Room 8 off: the Nguyens' 11:00 PM booking moves to the smallest free room that fits", async () => {
    const owner = (
      await raw.query<{ id: string; user_id: string }>(
        "select id, user_id from memberships where venue_id = $1 and role = 'owner'",
        [venueId],
      )
    ).rows[0]!;
    const config = loadConfig({
      WEST4_ENV: "local",
      DATABASE_URL: db.url,
      APP_DATABASE_URL: db.url,
    });
    const admin = buildApp({
      config,
      clock,
      moduleCacheMs: 0,
      authenticators: [
        async () =>
          ({
            kind: "user",
            userId: owner.user_id,
            session: "passkey",
            memberships: [{ venueId, membershipId: owner.id, role: "owner" }],
          }) as Principal,
      ],
    });
    await admin.ready();
    try {
      const r = await admin.inject({
        method: "PATCH",
        url: `/v1/venues/${venueId}/rooms/${ids["room_8"]}/state`,
        payload: { state: "out_of_service", reason: "Switched off" },
      });
      expect(r.statusCode, r.body).toBe(200);
      const reassigned = json(r)["reassigned"] as {
        moved: { booking_id: string; to_room_id: string }[];
        unplaced: unknown[];
      };
      expect(reassigned.unplaced).toEqual([]);
      expect(reassigned.moved).toHaveLength(1);
      expect(reassigned.moved[0]!.booking_id).toBe(ids["bk_nguyens"]);
      // Room 5's walk-in session ends at 11:00 PM, so it's free from then: the smallest room that fits 6.
      expect(reassigned.moved[0]!.to_room_id).toBe(ids["room_5"]);
      const b = await raw.query<{ room_id: string }>("select room_id from bookings where id = $1", [
        ids["bk_nguyens"],
      ]);
      expect(b.rows[0]!.room_id).toBe(ids["room_5"]);
    } finally {
      await admin.close();
    }
  });
});
