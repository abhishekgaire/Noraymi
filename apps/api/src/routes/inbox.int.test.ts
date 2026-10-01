import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { encryptSecret, loadDemoSeed, saveTwilioIntegration, withVenue } from "@west4/db";
import {
  appPool,
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
} from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, Temporal } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { twilioSignature } from "../texts/venue.js";

/**
 * M2-22 acceptance on the demo seed. Incoming texts arrive signed the way
 * Twilio signs them, on West 4's number; Diego reads and replies.
 */
const KEY = "e".repeat(64);
const secretKey = Buffer.from(KEY, "hex");
const ACCOUNT = "AC00000000000000000000000000west4";
const TOKEN = "west4-subaccount-token";
const WEST4 = "+12125550000";
const SAM = "+12125550110";
const MARCUS = "+19175550187";
const HOOK = "https://api.example.test/v1/hooks/twilio";
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
const at = (hhmm: string) => Temporal.Instant.from(`2026-09-25T${hhmm}:00-04:00`);
const req = (method: "GET" | "POST", path: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/v1/venues/${venueId}${path}`,
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
const incoming = (params: Record<string, string>, token = TOKEN) =>
  app.inject({
    method: "POST",
    url: "/v1/hooks/twilio",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      host: "api.example.test",
      "x-twilio-signature": twilioSignature(token, HOOK, params),
    },
    payload: new URLSearchParams(params).toString(),
  });
type Conversation = {
  id: string;
  guest_name: string | null;
  unread: number;
  context_kind: string | null;
  context_id: string | null;
  assigned_to: string | null;
};
type Message = { direction: string; body: string; automatic: boolean; at: string | null };
const list = async () =>
  (await req("GET", "/conversations")).json<{ conversations: Conversation[]; unread: number }>();

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
  await withVenue(pool, { venueId }, (c) =>
    saveTwilioIntegration(c, venueId, {
      accountSid: ACCOUNT,
      phoneE164: WEST4,
      secretEnc: encryptSecret(secretKey, TOKEN),
      at: SEED_NOW.toString(),
    }),
  );
  const diego: Principal = {
    kind: "user",
    userId: ids["diego"]!,
    session: "pin",
    memberships: [{ venueId, membershipId: ids["diego.membership"]!, role: "front_desk" }],
  };
  process.env["PUBLIC_API_URL"] = "https://api.example.test";
  app = buildApp({
    config: loadConfig({
      WEST4_ENV: "local",
      DATABASE_URL: db.url,
      APP_DATABASE_URL: db.url,
      AUTH_SECRET_KEY: KEY,
    }),
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

describe("the two-way inbox", () => {
  it("Sam O.'s running 15 late (10:24 PM) is unread on his 10:30 PM Room 2 booking; Marcus T.'s and Bianca L.'s threads read as in the seed", async () => {
    const all = await list();
    expect(all.unread).toBe(1);
    expect(all.conversations[0]).toMatchObject({
      guest_name: "Sam O.",
      unread: 1,
      context_kind: "booking",
      context_id: ids["bk_sam"],
    });
    const marcus = all.conversations.find((c) => c.guest_name === "Marcus T.")!;
    const thread = (await req("GET", `/conversations/${marcus.id}`)).json<{ messages: Message[] }>()
      .messages;
    expect(thread.map((m) => [m.direction, m.automatic, m.body])).toEqual([
      [
        "outbound",
        true,
        "Booked. Room for 12 at 8:00 PM, Fri Sep 25. Deposit $120 paid, comes off your bill.",
      ],
      ["inbound", false, "if we're having fun can we stay past 11?"],
      [
        "outbound",
        false,
        "Nobody has Room 9 after you tonight, so you can stay on by the minute until we close at 4 AM.",
      ],
    ]);
    const bianca = all.conversations.find((c) => c.guest_name === "Bianca L.")!;
    expect(
      (await req("GET", `/conversations/${bianca.id}`))
        .json<{ messages: Message[] }>()
        .messages.map((m) => m.body),
    ).toEqual([
      "Your VIP room is confirmed for Fri 9:30 PM. Deposit received, thank you.",
      "can we bring a cake?",
    ]);
  });

  it("an incoming text: signature first, run once, into the open conversation, unread, assigned to Andy, with the board and his phone told", async () => {
    clock.set(at("22:43"));
    const params = {
      AccountSid: ACCOUNT,
      MessageSid: "SM_in_1",
      From: SAM,
      To: WEST4,
      Body: "actually 20 late, sorry",
    };
    expect((await incoming(params, "wrong-token")).statusCode).toBe(403);
    const r = await incoming(params);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toBe("<Response></Response>");
    expect((await incoming(params)).statusCode).toBe(200); // the retry adds nothing
    const sam = (await list()).conversations.find((c) => c.guest_name === "Sam O.")!;
    expect(sam).toMatchObject({ unread: 2, assigned_to: ids["andy"], context_id: ids["bk_sam"] });
    const events = await raw.query(
      "select 1 from venue_events where type = 'message.received' and entity_id = $1",
      [sam.id],
    );
    expect(events.rowCount).toBe(1);
    const push = await raw.query<{ who: string }>(
      "select payload->'audience'->>'user_id' as who from jobs where kind = 'push.send' and payload->'message'->>'key' = 'messages.push'",
    );
    expect(push.rows).toEqual([{ who: ids["andy"] }]);
  });

  it("a text from a number with no thread tonight goes to its context: Marcus T.'s open Room 9 session", async () => {
    await raw.query(
      "update messages set created_at = created_at - interval '1 day' where conversation_id in (select id from conversations where phone_e164 = $1)",
      [MARCUS],
    );
    const r = await incoming({
      AccountSid: ACCOUNT,
      MessageSid: "SM_in_2",
      From: MARCUS,
      To: WEST4,
      Body: "one more round please",
    });
    expect(r.statusCode).toBe(200);
    const row = await raw.query<{ context_kind: string; context_id: string }>(
      "select cv.context_kind, cv.context_id from messages m join conversations cv on cv.id = m.conversation_id where m.provider_sid = 'SM_in_2'",
    );
    expect(row.rows[0]).toEqual({ context_kind: "session", context_id: ids["sess_room9"] });
  });

  it("reading a thread marks it read", async () => {
    const sam = (await list()).conversations.find((c) => c.guest_name === "Sam O.")!;
    await req("GET", `/conversations/${sam.id}`);
    expect((await list()).conversations.find((c) => c.guest_name === "Sam O.")!.unread).toBe(0);
  });

  it('Reply "no problem" sends the Running late reply and holds Room 2 for Sam O. until 10:45 PM', async () => {
    const sam = (await list()).conversations.find((c) => c.guest_name === "Sam O.")!;
    const r = await req("POST", `/conversations/${sam.id}/running-late`, {});
    expect(r.statusCode, r.body).toBe(201);
    expect(
      Temporal.Instant.from(r.json<{ running_late_until: string }>().running_late_until).toString(),
    ).toBe(at("22:45").toString());
    const sent = await raw.query<{ body: string; status: string; sent_by: string }>(
      "select body, status, sent_by from messages where id = $1",
      [r.json<{ message_id: string }>().message_id],
    );
    expect(sent.rows[0]).toEqual({
      body: "No problem. We'll hold your room until 10:45 PM.",
      status: "sending",
      sent_by: ids["diego"],
    });
    const room2 = (await req("GET", "/rooms/availability"))
      .json<{ rooms: { name: string; current: { kind: string; held_until: string } | null }[] }>()
      .rooms.find((x) => x.name === "Room 2")!;
    expect(room2.current).toMatchObject({ kind: "booking" });
    const booking = await raw.query<{ until: Date }>(
      "select running_late_until as until from bookings where id = $1",
      [ids["bk_sam"]],
    );
    expect(booking.rows[0]!.until.toISOString()).toBe(
      new Date(at("22:45").epochMilliseconds).toISOString(),
    );
    // Staff can change the time before sending.
    const later = await req("POST", `/conversations/${sam.id}/running-late`, {
      until: at("22:50").toString(),
    });
    expect(later.statusCode).toBe(201);
    const body = await raw.query<{ body: string }>("select body from messages where id = $1", [
      later.json<{ message_id: string }>().message_id,
    ]);
    expect(body.rows[0]!.body).toBe("No problem. We'll hold your room until 10:50 PM.");
  });

  it("a free-text reply with a link or a promotion is refused; a plain one goes", async () => {
    const sam = (await list()).conversations.find((c) => c.guest_name === "Sam O.")!;
    const link = await req("POST", `/conversations/${sam.id}/messages`, {
      body: "Book again at west4karaoke.com/book",
    });
    expect(link.statusCode).toBe(400);
    expect(link.json()).toMatchObject({ error: { details: { reason: "link" } } });
    const promo = await req("POST", `/conversations/${sam.id}/messages`, {
      body: "Come back Tuesday for 50% off",
    });
    expect(promo.json()).toMatchObject({ error: { details: { reason: "promotion" } } });
    const ok = await req("POST", `/conversations/${sam.id}/messages`, { body: "See you soon!" });
    expect(ok.statusCode, ok.body).toBe(201);
    // No free text where the guest hasn't written.
    const noThread = await raw.query<{ id: string }>(
      "insert into conversations (venue_id, phone_e164) values ($1, '+12125550123') returning id",
      [venueId],
    );
    const cold = await req("POST", `/conversations/${noThread.rows[0]!.id}/messages`, {
      body: "Hello",
    });
    expect(cold.json()).toMatchObject({ error: { details: { reason: "not_open" } } });
  });

  it("the venue wall: another venue's number and token never reach West 4's inbox", async () => {
    const other = await seedTwoVenues(db.url);
    const OTHER = "+12125550999";
    const OTHER_TOKEN = "other-venue-token";
    await withVenue(pool, { venueId: other.venueB }, (c) =>
      saveTwilioIntegration(c, other.venueB, {
        accountSid: "AC0000000000000000000000000other",
        phoneE164: OTHER,
        secretEnc: encryptSecret(secretKey, OTHER_TOKEN),
        at: SEED_NOW.toString(),
      }),
    );
    const before = await raw.query("select count(*)::int as n from messages where venue_id = $1", [
      venueId,
    ]);
    // To West 4's number, signed with the other venue's token: refused.
    const forged = await incoming(
      {
        AccountSid: "AC0000000000000000000000000other",
        MessageSid: "SM_x_1",
        From: SAM,
        To: WEST4,
        Body: "hi",
      },
      OTHER_TOKEN,
    );
    expect(forged.statusCode).toBe(403);
    // To the other venue's number, from Sam's phone: it lands there, never in West 4's thread.
    const there = await incoming(
      {
        AccountSid: "AC0000000000000000000000000other",
        MessageSid: "SM_x_2",
        From: SAM,
        To: OTHER,
        Body: "hi there",
      },
      OTHER_TOKEN,
    );
    expect(there.statusCode).toBe(200);
    const landed = await raw.query<{ venue_id: string }>(
      "select venue_id from messages where provider_sid = 'SM_x_2'",
    );
    expect(landed.rows).toEqual([{ venue_id: other.venueB }]);
    expect(
      (await raw.query("select count(*)::int as n from messages where venue_id = $1", [venueId]))
        .rows,
    ).toEqual(before.rows);
  });
});
