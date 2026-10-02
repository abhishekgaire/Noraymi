import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { Worker, loadDemoSeed } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, Temporal } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { makeSendMessageHandler } from "../jobs/send-message.js";
import { sweepWaitlistOffers } from "../rooms/waitlist.js";
import { MESSAGE_SEND_KIND } from "../texts/queue.js";
import { TEXT_TRIGGER_KIND, makeTextTriggerHandler, sweepTextTriggers } from "../texts/triggers.js";

/**
 * M2-26 acceptance on the demo seed and the simulated clock. No Twilio number
 * is set up here, so the Room ready text fails the way a failed text does.
 */
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
let slug = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
const at = (hhmm: string) => Temporal.Instant.from(`2026-09-25T${hhmm}:00-04:00`);
const staff = (method: "GET" | "POST", path: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/v1/venues/${venueId}${path}`,
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
const pub = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: { authorization: "" },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
type Entry = {
  id: string;
  name: string;
  status: string;
  offered_room_name: string | null;
  offer_expires_at: string | null;
  offer_text_status: string | null;
  phone_e164: string;
};
const entries = async () =>
  (await staff("GET", "/waitlist")).json<{
    entries: Entry[];
    suggestion: { name: string; room_name: string } | null;
  }>();
const drain = async (handlers: Parameters<typeof makeSendMessageHandler> | null, kind: string) => {
  const worker = new Worker(pool, {
    pool: "normal",
    clock,
    handlers:
      kind === MESSAGE_SEND_KIND
        ? { [MESSAGE_SEND_KIND]: makeSendMessageHandler(...handlers!) }
        : { [TEXT_TRIGGER_KIND]: makeTextTriggerHandler({ allowList: null }) },
  });
  while ((await worker.tick()) > 0);
};
const textsTo = async (phone: string) =>
  (
    await raw.query<{ key: string; body: string; status: string }>(
      `select t.key, m.body, m.status from messages m join conversations cv on cv.id = m.conversation_id
         join message_templates t on t.id = m.template_id where cv.phone_e164 = $1 order by m.created_at`,
      [phone],
    )
  ).rows;

const reseed = async () => {
  await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } });
  clock.set(SEED_NOW);
};

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  pool = appPool(db.url);
  slug = (await raw.query<{ slug: string }>("select slug from venues where id = $1", [venueId]))
    .rows[0]!.slug;
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
    authenticators: [async (request) => (request.headers.authorization === "" ? undefined : diego)],
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

describe("offering a waiting party a room", () => {
  it("the board suggests Room 11 for Amara B.; offering it holds Room 11 ten minutes and texts her Room ready", async () => {
    const before = await entries();
    expect(before.suggestion).toMatchObject({ name: "Amara B.", room_name: "Room 11" });
    const r = await staff("POST", `/waitlist/${ids["wl_1"]}/offer`);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ offer: { room_name: "Room 11" } });
    const amara = (await entries()).entries.find((e) => e.name === "Amara B.")!;
    expect(amara).toMatchObject({
      status: "offered",
      offered_room_name: "Room 11",
      offer_text_status: "sending",
    });
    expect(
      Temporal.Instant.from(amara.offer_expires_at!).since(SEED_NOW).total("minutes"),
    ).toBeCloseTo(10, 0);
    const hold = await raw.query<{ kind: string; expires_at: Date }>(
      "select kind, expires_at from room_blocks where ref_id = $1",
      [ids["wl_1"]],
    );
    expect(hold.rows.map((h) => h.kind)).toEqual(["hold"]);
    expect(await textsTo(amara.phone_e164)).toEqual([
      {
        key: "room_ready",
        body: "Your room is ready: Room 11. You have 10 minutes to claim it at the front desk.",
        status: "sending",
      },
    ]);
  });

  it("when the text fails, her row shows it failed (Not delivered · Call) with her number", async () => {
    await drain(
      [{ send: async () => ({ sid: "x" }) }, { publicApiUrl: null }, Buffer.alloc(32)],
      MESSAGE_SEND_KIND,
    );
    const amara = (await entries()).entries.find((e) => e.name === "Amara B.")!;
    expect(amara).toMatchObject({ offer_text_status: "failed", phone_e164: "+13475550177" });
  });

  it("with 5 minutes left she gets Offer expiring; at 10 minutes the hold goes and Room 11 is offered to Nadia K.", async () => {
    clock.set(SEED_NOW.add({ minutes: 4 }));
    await sweepTextTriggers(pool, clock.now());
    await drain(null, TEXT_TRIGGER_KIND);
    expect((await textsTo("+13475550177")).map((x) => x.key)).toEqual(["room_ready"]);
    clock.set(SEED_NOW.add({ minutes: 5, seconds: 30 }));
    await sweepTextTriggers(pool, clock.now());
    await drain(null, TEXT_TRIGGER_KIND);
    expect((await textsTo("+13475550177")).map((x) => [x.key, x.body])).toEqual([
      [
        "room_ready",
        "Your room is ready: Room 11. You have 10 minutes to claim it at the front desk.",
      ],
      [
        "offer_expiring",
        "5 minutes left to claim your room at West 4 Boho Karaoke. After that it goes to the next party in line.",
      ],
    ]);
    clock.set(SEED_NOW.add({ minutes: 9 }));
    expect(await sweepWaitlistOffers(pool, clock.now(), { allowList: null })).toEqual([]);
    // The clock ticks with real time from the reseed, and the offer was made a moment after it: 30
    // seconds past the 10 minutes leaves room for a busy machine (it failed under load at 10:01).
    clock.set(SEED_NOW.add({ minutes: 10, seconds: 30 }));
    expect(await sweepWaitlistOffers(pool, clock.now(), { allowList: null })).toEqual([
      { venueId, expired: [ids["wl_1"]] },
    ]);
    const list = (await entries()).entries;
    expect(list.map((e) => e.name)).not.toContain("Amara B.");
    expect(list.find((e) => e.name === "Nadia K.")).toMatchObject({
      status: "offered",
      offered_room_name: "Room 11",
    });
    const holds = await raw.query(
      "select ref_id from room_blocks where kind = 'hold' and room_id = $1",
      [ids["room_11"]],
    );
    expect(holds.rows).toEqual([{ ref_id: ids["wl_2"] }]);
  });

  it("Seat opens check-in in Room 11 for Amara's party of 7", async () => {
    await reseed();
    expect((await staff("POST", `/waitlist/${ids["wl_1"]}/offer`)).statusCode).toBe(201);
    const r = await staff("POST", `/waitlist/${ids["wl_1"]}/seat`, {
      ids_checked: 7,
      minutes: 120,
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ room_name: "Room 11", billable_guests: 7 });
    const entry = await raw.query<{ status: string; check_id: string }>(
      "select status, check_id from waitlist_entries where id = $1",
      [ids["wl_1"]],
    );
    expect(entry.rows[0]).toMatchObject({
      status: "seated",
      check_id: r.json<{ check_id: string }>().check_id,
    });
    expect(
      (
        await raw.query("select 1 from room_blocks where ref_id = $1 and kind = 'hold'", [
          ids["wl_1"],
        ])
      ).rowCount,
    ).toBe(0);
  });

  it("after Sam O.'s no-show at 10:45 PM, the fourth party's page reads Room 2 is ready · 10:00 to claim it", async () => {
    await reseed();
    const joined = await pub("POST", `/v1/public/venues/${slug}/waitlist`, {
      name: "Jordan L.",
      phone: "+12125550145",
      party_size: 4,
    });
    expect(joined.json()).toMatchObject({ spot: { ahead: 3 } });
    const token = joined.json<{ token: string }>().token;
    clock.set(at("22:45"));
    expect((await staff("POST", `/bookings/${ids["bk_sam"]}/no-show`, {})).statusCode).toBe(200);
    const jordan = (await entries()).entries.find((e) => e.name === "Jordan L.")!;
    const offer = await staff("POST", `/waitlist/${jordan.id}/offer`);
    expect(offer.statusCode, offer.body).toBe(201);
    expect(offer.json()).toMatchObject({ offer: { room_name: "Room 2" } });
    const page = await pub("GET", `/v1/public/waitlist/${token}`);
    expect(page.json()).toMatchObject({
      spot: { status: "offered", offer: { room_name: "Room 2", seconds_left: 600 } },
    });
    // Giving it away releases Room 2 to the next party that fits.
    const declined = await pub("PATCH", `/v1/public/waitlist/${token}`, { action: "decline" });
    expect(declined.json()).toMatchObject({ spot: { status: "declined" } });
    expect(
      (await raw.query("select 1 from room_blocks where ref_id = $1", [jordan.id])).rowCount,
    ).toBe(0);
  });
});
