import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, Temporal } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { hashRoomCode, newRoomCode } from "../rooms/checkin.js";

/** M2-11 acceptance on the demo seed and the simulated clock. */
const at = (hhmm: string, day = "2026-09-25") => Temporal.Instant.from(`${day}T${hhmm}:00-04:00`);

interface World {
  db: TestDatabase;
  raw: pg.Client;
  app: FastifyInstance;
  venueId: string;
  ids: Record<string, string>;
  clock: SimulatedClock;
}

async function world(): Promise<World> {
  const db = await createTestDatabase({ migrate: true });
  const venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } }))
    .venueId;
  const raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  const ids = Object.fromEntries(
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
  const clock = new SimulatedClock(SEED_NOW);
  const app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [async () => diego],
    moduleCacheMs: 0,
  });
  await app.ready();
  return { db, raw, app, venueId, ids, clock };
}
const close = async (w: World) => {
  await w.app.close();
  await w.raw.end();
  await w.db.drop();
};
const req = (w: World, method: "GET" | "POST", path: string, payload?: unknown) =>
  w.app.inject({
    method,
    url: `/v1/venues/${w.venueId}${path}`,
    ...(payload === undefined ? {} : { payload: payload as never }),
  });

describe("checking in Sam O. at 10:44 PM", () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  });
  afterAll(async () => close(w));

  it("the sheet shows 3 guests with Friday's minimum of 4 and his −$40.00 deposit; no-show isn't allowed yet", async () => {
    w.clock.set(at("22:44"));
    const r = await req(w, "GET", `/check-in/preview?booking=${w.ids["bk_sam"]}`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      guest_name: "Sam O.",
      party_size: 3,
      min_guests: 4,
      billable_guests: 4,
      min_day: "friday",
      hourly_cents: 4000,
      room_name: "Room 2",
      deposit_cents: 4000,
      can_no_show: false,
      no_show_from: at("22:45").toString(),
    });
    const early = await req(w, "POST", `/bookings/${w.ids["bk_sam"]}/no-show`);
    expect(early.statusCode).toBe(400);
  });

  it("checking in seats him in Room 2 with a new 5-character code (never a 2), texts it with the join link, and bills $40.00", async () => {
    w.clock.set(at("22:44"));
    const r = await req(w, "POST", `/bookings/${w.ids["bk_sam"]}/check-in`, {
      party_size: 3,
      ids_checked: 3,
    });
    expect(r.statusCode, r.body).toBe(201);
    const seated = r.json() as {
      room_name: string;
      room_code: string;
      check_number: number;
      billable_guests: number;
      deposit_cents: number;
      text: string;
      session_id: string;
    };
    expect(seated).toMatchObject({
      room_name: "Room 2",
      billable_guests: 4,
      deposit_cents: 4000,
      text: "queued",
      check_number: 1054,
    });
    expect(seated.room_code).toMatch(/^[A-Z3-9]{5}$/);
    expect(seated.room_code).not.toContain("2");
    const session = await w.raw.query<{
      room_code_hash: string;
      token_version: number;
      host_token_hash: string;
    }>("select room_code_hash, token_version, host_token_hash from room_sessions where id = $1", [
      seated.session_id,
    ]);
    expect(session.rows[0]).toMatchObject({
      room_code_hash: hashRoomCode(w.venueId, seated.room_code),
      token_version: 1,
    });
    expect(session.rows[0]!.host_token_hash).toMatch(/^[0-9a-f]{64}$/);
    const text = await w.raw.query<{ body: string; phone_e164: string; status: string }>(
      "select m.body, cv.phone_e164, m.status from messages m join conversations cv on cv.id = m.conversation_id where cv.context_id = $1",
      [seated.session_id],
    );
    expect(text.rows[0]).toMatchObject({ phone_e164: "+12125550110", status: "sending" });
    expect(text.rows[0]!.body).toContain(
      `enter room code ${seated.room_code}. Or open http://localhost:3001/r/`,
    );
    expect(
      (await w.raw.query("select status from bookings where id = $1", [w.ids["bk_sam"]])).rows[0],
    ).toEqual({ status: "checked_in" });
    expect(
      (await w.raw.query("select state from room_states where room_id = $1", [w.ids["room_2"]]))
        .rows[0],
    ).toEqual({ state: "in_use" });
    const blocks = await w.raw.query<{ kind: string }>(
      "select kind from room_blocks where room_id = $1 order by lower(period)",
      [w.ids["room_2"]],
    );
    expect(blocks.rows.map((b) => b.kind)).toEqual(["session"]);
    w.clock.set(at("23:00"));
    const s = (await req(w, "GET", `/sessions/${seated.session_id}`)).json() as {
      session: { minutes: number; room_time_cents: number };
    };
    expect(s.session).toMatchObject({ minutes: 16, room_time_cents: 4000 });
  });

  it("+ Walk-in on Room 11 seats the party with a new code", async () => {
    w.clock.set(at("22:46"));
    const preview = (
      await req(w, "GET", `/check-in/preview?room=${w.ids["room_11"]}&party=7`)
    ).json();
    expect(preview).toMatchObject({
      room_name: "Room 11",
      party_size: 7,
      billable_guests: 7,
      room_fits: true,
      booking_id: null,
    });
    const r = await req(w, "POST", `/rooms/${w.ids["room_11"]}/sessions`, {
      party_size: 7,
      ids_checked: 7,
      minutes: 120,
      guest: { name: "Leo M.", phone_e164: "+12125550103" },
    });
    expect(r.statusCode, r.body).toBe(201);
    const seated = r.json() as {
      room_name: string;
      room_code: string;
      hourly_cents: number;
      text: string;
    };
    expect(seated).toMatchObject({ room_name: "Room 11", hourly_cents: 7000, text: "queued" });
    expect(seated.room_code).not.toMatch(/1/);
  });

  it("a room that doesn't fit, or isn't free, answers 409 room_not_free", async () => {
    w.clock.set(at("22:47"));
    const taken = await req(w, "POST", `/rooms/${w.ids["room_9"]}/sessions`, {
      party_size: 4,
      ids_checked: 0,
      minutes: 60,
    });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ error: { code: "room_not_free" } });
    const tooSmall = await req(w, "POST", `/bookings/${w.ids["bk_nguyens"]}/check-in`, {
      party_size: 13, // Room 8 holds 12
      ids_checked: 0,
    });
    expect(tooSmall.statusCode).toBe(409);
    // Room 8 is booked at 11:00 by the Nguyens: a walk-in until midnight there isn't free.
    const clash = await req(w, "POST", `/rooms/${w.ids["room_8"]}/sessions`, {
      party_size: 4,
      ids_checked: 0,
      minutes: 75,
    });
    expect(clash.statusCode).toBe(409);
  });

  it("room codes leave out the room's own digits and the easily misread characters", () => {
    let i = 0;
    const seq = () => i++ % 3;
    expect(newRoomCode("Room 12", seq)).toMatch(/^[A-Z3-9]{5}$/);
    for (let n = 0; n < 200; n++) {
      const code = newRoomCode("Room 7");
      expect(code).not.toMatch(/[7015OIBLS8]/);
    }
  });
});

describe("Mark no-show", () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  });
  afterAll(async () => close(w));

  it("is refused at 10:44 PM; from 10:45 PM it's allowed, and marking it frees Room 2", async () => {
    w.clock.set(at("22:44"));
    expect((await req(w, "POST", `/bookings/${w.ids["bk_sam"]}/no-show`)).statusCode).toBe(400);
    w.clock.set(at("22:45"));
    expect(
      (
        (await req(w, "GET", `/check-in/preview?booking=${w.ids["bk_sam"]}`)).json() as {
          can_no_show: boolean;
        }
      ).can_no_show,
    ).toBe(true);
    const r = await req(w, "POST", `/bookings/${w.ids["bk_sam"]}/no-show`);
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as { booking: { status: string } }).booking.status).toBe("no_show");
    const avail = (await req(w, "GET", "/rooms/availability")).json() as {
      rooms: { name: string; free_now: boolean }[];
    };
    expect(avail.rooms.find((x) => x.name === "Room 2")?.free_now).toBe(true);
  });
});
