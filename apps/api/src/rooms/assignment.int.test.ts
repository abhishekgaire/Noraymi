import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { addBlock, loadDemoSeed, RoomNotFree, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, Temporal } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { sweepHolds } from "../jobs/hold-sweep.js";
import { assignBooking, extendSession } from "./assignment.js";

/**
 * M2-05 acceptance on the demo seed (and fixtures beside it): the exclusion
 * constraint, hold expiry, the board's "free until" at 10:41 PM, assignment by
 * size, the close, and a session's 15-minute extensions.
 */
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
const clock = new SimulatedClock(SEED_NOW);
const at = (hhmm: string, day = "2026-09-25") => Temporal.Instant.from(`${day}T${hhmm}:00-04:00`);
let ids: Record<string, string> = {};
const seedId = (slug: string): string => {
  const id = ids[slug];
  if (!id) throw new Error(`no seed id for ${slug}`);
  return id;
};
const room = (slug: string) => seedId(slug);
const inVenue = <T>(
  work: (c: Parameters<Parameters<typeof withVenue>[2]>[0]) => Promise<T>,
): Promise<T> => withVenue(pool, { venueId }, work);

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  const loaded = await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } });
  venueId = loaded.venueId;
  pool = appPool(db.url);
  const raw = new pg.Client({ connectionString: db.url });
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
      "select id, user_id from memberships where venue_id = $1 and role = 'owner'",
      [venueId],
    )
  ).rows[0]!;
  await raw.end();
  const owner: Principal = {
    kind: "user",
    userId: m.user_id,
    session: "passkey",
    memberships: [{ venueId, membershipId: m.id, role: "owner" }],
  };
  const config = loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url });
  app = buildApp({ config, clock, authenticators: [async () => owner], moduleCacheMs: 0 });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe("room blocks and assignment", () => {
  it("at 10:41 PM: Room 11 is free all night, Room 8 until 11:00 PM, and Room 2 is held for Sam O. until 10:45 PM", async () => {
    const r = await app.inject({ method: "GET", url: `/v1/venues/${venueId}/rooms/availability` });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as { close: string; rooms: Array<Record<string, unknown>> };
    const byName = (n: string) => body.rooms.find((x) => x["name"] === n)!;
    expect(body.close).toBe(at("04:00", "2026-09-26").toString());
    expect(byName("Room 11")).toMatchObject({ free_now: true, all_night: true, until: body.close });
    expect(byName("Room 8")).toMatchObject({
      free_now: true,
      all_night: false,
      until: at("23:00").toString(),
    });
    expect(byName("Room 2")).toMatchObject({
      free_now: false,
      current: { kind: "booking", ref_id: seedId("bk_sam"), held_until: at("22:45").toString() },
    });
    expect(byName("Room 4")).toMatchObject({
      free_now: false,
      until: null,
      current: { kind: "out_of_service" },
    });
    expect(byName("Room 6")).toMatchObject({ free_now: false, current: { kind: "cleaning" } });
    expect(byName("Room 10")).toMatchObject({ free_now: false, current: { kind: "session" } });
    expect(body.rooms.filter((x) => x["free_now"])).toHaveLength(2);
  });

  it("two overlapping blocks in one room can't both be written", async () => {
    await expect(
      inVenue((c) =>
        addBlock(c, {
          venueId,
          roomId: room("room_11"),
          kind: "booking",
          from: at("23:00"),
          to: at("00:00", "2026-09-26"),
        }),
      ),
    ).resolves.toMatchObject({ kind: "booking" });
    await expect(
      inVenue((c) =>
        addBlock(c, {
          venueId,
          roomId: room("room_11"),
          kind: "hold",
          from: at("23:30"),
          to: at("00:30", "2026-09-26"),
          expiresAt: at("22:51"),
        }),
      ),
    ).rejects.toBeInstanceOf(RoomNotFree);
    // Touching ends don't overlap: [11:00, 12:00) and [12:00, 1:00).
    await expect(
      inVenue((c) =>
        addBlock(c, {
          venueId,
          roomId: room("room_11"),
          kind: "booking",
          from: at("00:00", "2026-09-26"),
          to: at("01:00", "2026-09-26"),
        }),
      ),
    ).resolves.toMatchObject({ kind: "booking" });
  });

  it("a 10-minute hold is gone after it expires, and its room is free again", async () => {
    await inVenue((c) =>
      addBlock(c, {
        venueId,
        roomId: room("room_8"),
        kind: "hold",
        from: at("22:41"),
        to: at("22:55"),
        expiresAt: at("22:51"),
      }),
    );
    const before = await app.inject({
      method: "GET",
      url: `/v1/venues/${venueId}/rooms/availability?at=${encodeURIComponent(at("22:45").toString())}`,
    });
    expect(
      (before.json() as { rooms: Array<Record<string, unknown>> }).rooms.find(
        (x) => x["name"] === "Room 8",
      ),
    ).toMatchObject({
      free_now: false,
      current: { kind: "hold", held_until: at("22:51").toString() },
    });
    expect(await sweepHolds(pool, at("22:50"))).toEqual([]);
    expect(await sweepHolds(pool, at("22:51"))).toEqual([{ venueId, rooms: [room("room_8")] }]);
    const after = await app.inject({
      method: "GET",
      url: `/v1/venues/${venueId}/rooms/availability?at=${encodeURIComponent(at("22:52").toString())}`,
    });
    expect(
      (after.json() as { rooms: Array<Record<string, unknown>> }).rooms.find(
        (x) => x["name"] === "Room 8",
      ),
    ).toMatchObject({
      free_now: true,
      until: at("23:00").toString(),
    });
  });

  it("a party of 7 is given a medium room when one is free, and Room 11 only when none is", async () => {
    // Tomorrow at 7 PM nothing is booked: a medium room (Room 6 is the first of them).
    const first = await inVenue((c) =>
      assignBooking(c, venueId, {
        party: 7,
        from: at("19:00", "2026-09-26"),
        to: at("21:00", "2026-09-26"),
        refId: null,
      }),
    );
    expect(first.room_id).toBe(room("room_6"));
    // Fill the other mediums (Room 7 to 10) for that time; the next party of 7 goes to Room 11.
    for (const slug of ["room_7", "room_8", "room_9", "room_10"])
      await inVenue((c) =>
        addBlock(c, {
          venueId,
          roomId: room(slug),
          kind: "booking",
          from: at("18:00", "2026-09-26"),
          to: at("22:00", "2026-09-26"),
        }),
      );
    const second = await inVenue((c) =>
      assignBooking(c, venueId, {
        party: 7,
        from: at("19:00", "2026-09-26"),
        to: at("21:00", "2026-09-26"),
        refId: null,
      }),
    );
    expect(second.room_id).toBe(room("room_11"));
    // A party of 4 still gets the smallest free room that fits, never Room 4 (out of service).
    const small = await inVenue((c) =>
      assignBooking(c, venueId, {
        party: 4,
        from: at("19:00", "2026-09-26"),
        to: at("20:00", "2026-09-26"),
        refId: null,
      }),
    );
    expect(small.room_id).toBe(room("room_1"));
  });

  it("a booking that would end after the 4:00 AM close is refused", async () => {
    await expect(
      inVenue((c) =>
        assignBooking(c, venueId, {
          party: 4,
          from: at("03:00", "2026-09-27"),
          to: at("04:30", "2026-09-27"),
          refId: null,
        }),
      ),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: "a booking must end by the night's close",
    });
    const free = await app.inject({
      method: "GET",
      url: `/v1/venues/${venueId}/rooms/free?party=7&from=${encodeURIComponent(at("03:30", "2026-09-26").toString())}&minutes=60`,
    });
    expect(free.json()).toMatchObject({ past_close: true, rooms: [] });
    const ok = await app.inject({
      method: "GET",
      url: `/v1/venues/${venueId}/rooms/free?party=7&minutes=15`,
    });
    // Now, for 15 minutes: Room 8 (free until 11:00) and Room 11 (free until the booking an earlier test made).
    expect((ok.json() as { rooms: { name: string }[] }).rooms.map((r) => r.name)).toEqual([
      "Room 8",
      "Room 11",
    ]);
  });

  it("a session past its end extends 15 minutes at a time, only while nothing is booked next", async () => {
    const blocks = await inVenue((c) =>
      c.query<{ id: string; room: string }>(
        "select id, room_id as room from room_blocks where kind = 'session' and room_id in ($1, $2)",
        [room("room_10"), room("room_7")],
      ),
    );
    const tanya = blocks.rows.find((b) => b.room === room("room_10"))!.id;
    const rob = blocks.rows.find((b) => b.room === room("room_7"))!.id;
    // Room 10: nothing next tonight, so 10:45 becomes 11:00.
    const extended = await inVenue((c) => extendSession(c, venueId, tanya));
    expect(Temporal.Instant.from(extended.ends_at!).toString()).toBe(at("23:00").toString());
    // Room 7: the Parks are booked at 11:00; 10:45 + 15 would leave less than the 10-minute notice.
    await expect(inVenue((c) => extendSession(c, venueId, rob))).rejects.toMatchObject({
      code: "room_not_free",
      details: { reason: "booked_next" },
    });
  });
});
