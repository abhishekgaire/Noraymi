import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadDemoSeed, seedFilePath } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, Temporal } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import pg from "pg";

/** M2-29 acceptance: `GET /board` at 10:41 PM read against seed/west4-friday.json. */
type SeedRoom = { id: string; name: string; board_label: string };
type SeedSession = { id: string; room: string };
type SeedCheck = {
  id: string;
  room_session?: string;
  expected_at_now?: { room_time_cents?: number; tab_so_far_cents?: number };
};
const seed = JSON.parse(readFileSync(seedFilePath(), "utf8")) as {
  rooms: SeedRoom[];
  sessions: SeedSession[];
  checks: SeedCheck[];
  counts: {
    rooms: { in_use_or_wrap_up: number; open: number; cleaning: number; out_of_service: number };
  };
};
let db: TestDatabase;
let app: FastifyInstance;
let venueId = "";
const clock = new SimulatedClock(SEED_NOW);
type Words = {
  kind: string;
  minutes_left?: number;
  minutes_past?: number;
  left_at?: string;
  minutes?: number;
  name?: string;
  until?: string;
  at?: string;
};
type Tile = {
  name: string;
  words: Words;
  tone: string | null;
  session: { room_time_cents: number; tab_so_far_cents: number; minutes: number } | null;
};
const read = async () =>
  (await app.inject({ method: "GET", url: `/v1/venues/${venueId}/board` })).json<{
    rooms: Tile[];
    counts: { in_use: number; open: number; cleaning: number; out_of_service: number };
    headcount: { inside: number };
  }>();

/** The board's English words, as the staff app renders them. */
const hm = (iso: string, suffix: boolean) => {
  const z = Temporal.Instant.from(iso).toZonedDateTimeISO("America/New_York");
  const h = z.hour % 12 === 0 ? 12 : z.hour % 12;
  return `${h}:${String(z.minute).padStart(2, "0")}${suffix ? (z.hour < 12 ? " AM" : " PM") : ""}`;
};
const label = (w: Words): string => {
  switch (w.kind) {
    case "in_room":
      return `In room · ${w.minutes_left} min left`;
    case "wrap_up":
      return `Wrap up · ${w.minutes_left} min left`;
    case "staying":
      return `Staying · ${w.minutes_past} min past`;
    case "needed_now":
      return `Needed now · ${w.minutes_past} min past`;
    case "cleaning":
      return `Needs a wipe · left ${hm(w.left_at!, true)} (${w.minutes} min)`;
    case "held":
      return `Open · held for ${w.name} until ${hm(w.until!, false)}`;
    case "next":
      return `Open · next ${hm(w.at!, false)}`;
    case "free_all_night":
      return "Open · free all night";
    case "out_of_service":
      return "Out of service";
    default:
      return w.kind;
  }
};

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  const raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  const m = (
    await raw.query<{ id: string; user_id: string }>(
      "select id, user_id from memberships where venue_id = $1 and role = 'manager'",
      [venueId],
    )
  ).rows[0]!;
  await raw.end();
  const andy: Principal = {
    kind: "user",
    userId: m.user_id,
    session: "pin",
    memberships: [{ venueId, membershipId: m.id, role: "manager" }],
  };
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [async () => andy],
    moduleCacheMs: 0,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.drop();
});

describe("the Tonight board at 10:41 PM", () => {
  it("every tile's words match the seed's board labels", async () => {
    clock.set(SEED_NOW);
    const b = await read();
    expect(b.rooms).toHaveLength(14);
    const got = Object.fromEntries(b.rooms.map((r) => [r.name, label(r.words)]));
    const want = Object.fromEntries(seed.rooms.map((r) => [r.name, r.board_label]));
    expect(got).toEqual(want);
  });

  it("every running clock, room time and tab so far matches the seed to the cent", async () => {
    clock.set(SEED_NOW);
    const b = await read();
    for (const check of seed.checks.filter((x) => x.room_session && x.expected_at_now)) {
      const session = seed.sessions.find((s) => s.id === check.room_session)!;
      const room = seed.rooms.find((r) => r.id === session.room)!;
      const tile = b.rooms.find((r) => r.name === room.name)!;
      expect([room.name, tile.session?.room_time_cents, tile.session?.tab_so_far_cents]).toEqual([
        room.name,
        check.expected_at_now!.room_time_cents,
        check.expected_at_now!.tab_so_far_cents,
      ]);
    }
    expect(b.rooms.find((r) => r.name === "Room 9")!.session!.minutes).toBe(161);
    expect(b.rooms.find((r) => r.name === "VIP room")!.session!.minutes).toBe(71);
  });

  it("counts 8 in use, 3 open, 2 cleaning and 1 out of service, and colors Room 3 amber and Rooms 7 and 10 red", async () => {
    const b = await read();
    expect(b.counts).toEqual({
      in_use: seed.counts.rooms.in_use_or_wrap_up,
      open: seed.counts.rooms.open,
      cleaning: seed.counts.rooms.cleaning,
      out_of_service: seed.counts.rooms.out_of_service,
    });
    const tone = Object.fromEntries(b.rooms.map((r) => [r.name, r.tone]));
    expect([tone["Room 3"], tone["Room 7"], tone["Room 10"], tone["Room 1"]]).toEqual([
      "amber",
      "red",
      "red",
      null,
    ]);
    expect(b.headcount.inside).toBe(93);
  });

  it("one minute later every running clock and total moves by one minute's billing", async () => {
    clock.set(SEED_NOW);
    const before = await read();
    clock.set(SEED_NOW.add({ minutes: 1 }));
    const after = await read();
    const r9 = (b: typeof before) => b.rooms.find((r) => r.name === "Room 9")!.session!;
    expect(r9(after).minutes).toBe(162);
    // Room 9: 12 × $10 an hour is $2.00 a minute.
    expect(r9(after).room_time_cents - r9(before).room_time_cents).toBe(200);
    expect(r9(after).tab_so_far_cents - r9(before).tab_so_far_cents).toBe(200);
    // The VIP room: $250 an hour flat.
    const vip = (b: typeof before) => b.rooms.find((r) => r.name === "VIP room")!.session!;
    expect(vip(after).room_time_cents).toBe(Math.round((25000 * 72) / 60));
  });
});
