import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed, withVenue, Worker } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, Temporal } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { FakePushSender } from "../push/sender.js";
import { PUSH_SEND_KIND, makePushSendHandler } from "../push/send-push.js";
import { createCall } from "../rooms/calls.js";

/** M2-20 acceptance on the demo seed: room calls on the board and every staff phone. */
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
const req = (method: "GET" | "POST", path: string) =>
  app.inject({ method, url: `/v1/venues/${venueId}${path}` });
type Call = {
  id: string;
  room_name: string;
  kind: string;
  created_at: string;
  acked_by: string | null;
  acked_at: string | null;
};
const calls = async () => (await req("GET", "/calls")).json<{ calls: Call[] }>().calls;

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
  // Andy's, Maya's and Diego's phones, each subscribed to push.
  for (const who of ["andy", "maya", "diego"]) {
    const phone = await raw.query<{ id: string }>(
      "insert into devices (venue_id, kind, name, user_id, public_key) values ($1, 'staff_phone', $2, $3, '{}') returning id",
      [venueId, `${who}'s phone`, ids[who]],
    );
    await raw.query(
      `insert into push_subscriptions (venue_id, device_id, endpoint, keys) values ($1, $2, $3, '{"p256dh":"k","auth":"a"}')`,
      [venueId, phone.rows[0]!.id, `https://push.example.test/${who}`],
    );
  }
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

describe("room calls", () => {
  it("the seed's Room 9 call, another mic at 10:39 PM, is open on the board", async () => {
    const open = await calls();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ room_name: "Room 9", kind: "mic", acked_at: null });
    expect(Temporal.Instant.from(open[0]!.created_at).toString()).toBe(
      Temporal.Instant.from("2026-09-25T22:39:00-04:00").toString(),
    );
  });

  it("a new call reaches every staff phone with a push and the room's channel", async () => {
    const call = await withVenue(pool, { venueId }, (c) =>
      createCall(c, venueId, { sessionId: ids["sess_room5"]!, kind: "mic", now: clock.now() }),
    );
    const sender = new FakePushSender();
    const ownerPool = new pg.Pool({ connectionString: db.url, max: 2 });
    const worker = new Worker(ownerPool, {
      pool: "normal",
      handlers: { [PUSH_SEND_KIND]: makePushSendHandler(sender) },
      clock,
      random: () => 0.5,
    });
    expect(await worker.tick()).toBe(1);
    await ownerPool.end();
    expect(sender.sent.map((s) => s.endpoint).sort()).toEqual([
      "https://push.example.test/andy",
      "https://push.example.test/diego",
      "https://push.example.test/maya",
    ]);
    expect(JSON.parse(sender.sent[0]!.payload).body).toBe("Room 5: Another mic, please");
    const event = await raw.query(
      "select room_id from venue_events where type = 'room.call' and entity_id = $1",
      [call.id],
    );
    expect(event.rows).toEqual([{ room_id: ids["room_5"] }]);
  });

  it("Diego's On it clears the call everywhere and records Diego and the time", async () => {
    const seedCall = (await calls()).find((c) => c.room_name === "Room 9")!;
    const r = await req("POST", `/calls/${seedCall.id}/ack`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json<{ call: Call }>().call).toMatchObject({ acked_by: ids["diego"] });
    expect((await calls()).map((c) => c.room_name)).toEqual(["Room 5"]);
    const events = await raw.query<{ entity_version: number }>(
      "select entity_version from venue_events where type = 'room.call' and entity_id = $1 order by seq",
      [seedCall.id],
    );
    expect(events.rows.map((e) => e.entity_version)).toEqual([1]);
  });

  it("a TV or song call becomes a fault on its room in one tap", async () => {
    const call = await withVenue(pool, { venueId }, (c) =>
      createCall(c, venueId, { sessionId: ids["sess_room1"]!, kind: "tv", now: clock.now() }),
    );
    const r = await req("POST", `/calls/${call.id}/fault`);
    expect(r.statusCode, r.body).toBe(201);
    const fault = await raw.query(
      "select room_id, text, reported_by from room_faults where id = $1",
      [r.json<{ fault_id: string }>().fault_id],
    );
    expect(fault.rows).toEqual([
      { room_id: ids["room_1"], text: "TV or song isn't working", reported_by: ids["diego"] },
    ]);
    expect((await calls()).map((c) => c.room_name)).toEqual(["Room 5"]);
    const mic = (await calls())[0]!;
    expect((await req("POST", `/calls/${mic.id}/fault`)).statusCode).toBe(400);
  });
});
