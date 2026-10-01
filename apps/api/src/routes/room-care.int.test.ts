import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, Temporal } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { endTimedCleaning } from "../rooms/cleaning.js";

/** M2-19 acceptance on the demo seed and the simulated clock. */
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
const at = (hhmm: string) => Temporal.Instant.from(`2026-09-25T${hhmm}:00-04:00`);
const req = (method: "GET" | "POST" | "PATCH", path: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/v1/venues/${venueId}${path}`,
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
type Room = {
  name: string;
  state: string;
  free_now: boolean;
  cleaning: { left_at: string; minutes: number; flagged: boolean } | null;
  notes: { text: string }[];
};
const room = async (name: string) =>
  (await req("GET", "/rooms/availability"))
    .json<{ rooms: Room[] }>()
    .rooms.find((r) => r.name === name)!;

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
  const diego: Principal = {
    kind: "user",
    userId: ids["diego"]!,
    session: "pin",
    memberships: [{ venueId, membershipId: ids["diego.membership"]!, role: "front_desk" }],
  };
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [async () => diego],
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

describe("cleaning, room notes and lost and found", () => {
  it("Room 6 reads left 10:33 PM (8 min) at 10:41 PM and is flagged by 10:42 PM; Room 13 isn't flagged at 10:41", async () => {
    clock.set(at("22:41"));
    const r6 = await room("Room 6");
    expect(r6).toMatchObject({
      state: "cleaning",
      free_now: false,
      cleaning: { minutes: 8, flagged: false },
    });
    expect(Temporal.Instant.from(r6.cleaning!.left_at).toString()).toBe(at("22:33").toString());
    expect((await room("Room 13")).cleaning).toMatchObject({ minutes: 5, flagged: false });
    clock.set(at("22:42"));
    expect((await room("Room 6")).cleaning).toMatchObject({ minutes: 9, flagged: true });
  });

  it("Room 6 keeps its note", async () => {
    expect((await room("Room 6")).notes.map((n) => n.text)).toEqual([
      "TV remote goes missing. Check under the couch.",
    ]);
    const added = await req("POST", `/rooms/${ids["room_6"]}/notes`, {
      text: "Left speaker crackles",
    });
    expect(added.statusCode).toBe(201);
    expect((await room("Room 6")).notes.map((n) => n.text)).toEqual([
      "TV remote goes missing. Check under the couch.",
      "Left speaker crackles",
    ]);
  });

  it("marking Room 6 clean makes it Open and leaves every booking as it was", async () => {
    const bookings = async () =>
      (await raw.query("select id, room_id, starts_at, ends_at, status from bookings order by id"))
        .rows;
    const blocks = async () =>
      (
        await raw.query(
          "select id, room_id, period from room_blocks where kind in ('booking', 'hold') order by id",
        )
      ).rows;
    const [b0, k0] = [await bookings(), await blocks()];
    const r = await req("POST", `/rooms/${ids["room_6"]}/clean`);
    expect(r.statusCode, r.body).toBe(200);
    expect(await room("Room 6")).toMatchObject({
      state: "available",
      free_now: true,
      cleaning: null,
    });
    expect(await bookings()).toEqual(b0);
    expect(await blocks()).toEqual(k0);
    expect((await req("POST", `/rooms/${ids["room_6"]}/clean`)).statusCode).toBe(400);
  });

  it("with cleaning on a timer, a room ends cleaning by itself after the cleaning minutes", async () => {
    await raw.query(
      "update venue_settings set value = jsonb_set(jsonb_set(value, '{cleaningEnds}', '\"timer\"'), '{cleaningMin}', '10') where venue_id = $1 and key = 'rooms'",
      [venueId],
    );
    // Room 13 left at 10:36: not yet at 10:45, done at 10:46.
    expect(
      await withVenue(pool, { venueId }, (c) => endTimedCleaning(c, venueId, at("22:45"))),
    ).toEqual([]);
    expect(
      await withVenue(pool, { venueId }, (c) => endTimedCleaning(c, venueId, at("22:46"))),
    ).toEqual([ids["room_13"]]);
    expect((await room("Room 13")).state).toBe("available");
  });

  it("a lost item logged in Room 9 with a photo reads Found in Room 9 · kept at the bar, then claimed by …", async () => {
    const file = await raw.query<{ id: string }>(
      "insert into files (venue_id, kind, storage_key, content_type, bytes, uploaded_at) values ($1::uuid, 'lost_item_photo', $1::text || '/lost/scarf.jpg', 'image/jpeg', 2000, now()) returning id",
      [venueId],
    );
    const r = await req("POST", "/lost-items", {
      description: "Green scarf",
      kept_at: "the bar",
      room_id: ids["room_9"],
      photo_file_id: file.rows[0]!.id,
    });
    expect(r.statusCode, r.body).toBe(201);
    const item = r.json<{ item: Record<string, unknown> }>().item;
    expect(item).toMatchObject({
      room_name: "Room 9",
      kept_at: "the bar",
      session_id: ids["sess_room9"],
      photo_file_id: file.rows[0]!.id,
      found_by_name: "Diego R.",
      claimed_by_name: null,
    });
    const attached = await raw.query("select attached_at from files where id = $1", [
      file.rows[0]!.id,
    ]);
    expect(attached.rows[0]!.attached_at).not.toBeNull();
    const atBar = await req("POST", "/lost-items", { description: "Keys", kept_at: "the office" });
    expect(atBar.json<{ item: { room_id: string | null } }>().item.room_id).toBeNull();
    const claimed = await req("PATCH", `/lost-items/${item["id"] as string}`, {
      claimed_by_name: "Marcus T.",
    });
    expect(claimed.json<{ item: Record<string, unknown> }>().item).toMatchObject({
      claimed_by_name: "Marcus T.",
      handed_over_by: ids["diego"],
    });
    expect(
      (await req("GET", "/lost-items"))
        .json<{ items: { description: string }[] }>()
        .items.map((i) => i.description),
    ).toEqual(["Keys"]);
    expect((await req("GET", "/lost-items?all=1")).json<{ items: unknown[] }>().items).toHaveLength(
      2,
    );
    const wrongKind = await raw.query<{ id: string }>(
      "insert into files (venue_id, kind, storage_key, content_type, bytes, uploaded_at) values ($1::uuid, 'damage_photo', $1::text || '/d.jpg', 'image/jpeg', 10, now()) returning id",
      [venueId],
    );
    expect(
      (
        await req("POST", "/lost-items", {
          description: "x",
          kept_at: "bar",
          photo_file_id: wrongKind.rows[0]!.id,
        })
      ).statusCode,
    ).toBe(400);
  });
});
