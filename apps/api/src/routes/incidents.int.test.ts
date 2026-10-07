import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed, seedHostToken, Worker, type StampedEvent } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import {
  SEED_NOW,
  SimulatedClock,
  Temporal,
  makeDeviceKey,
  signDeviceRequest,
} from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { visibleTo } from "../http/event-filter.js";
import type { Principal } from "../http/principal.js";
import { FakePushSender } from "../push/sender.js";
import { PUSH_SEND_KIND, makePushSendHandler } from "../push/send-push.js";

/**
 * M8-08 acceptance on the demo seed: a guest in Room 9 asks for a manager
 * privately; only Andy's and Abhishek's phones hear of it; the board gets a
 * count; Andy takes it, adds a note and closes it; it's kept 3 years.
 */
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
const people: Record<string, Principal> = {};
let tabletKey: Awaited<ReturnType<typeof makeDeviceKey>>;

const cookieOf = (h: string | string[] | undefined) =>
  String(Array.isArray(h) ? h[0] : h).split(";")[0]!;
const guest = (cookie: string, method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({
    method,
    url: `/v1/public/room-session${url}`,
    headers: { cookie },
    ...(payload ? { payload } : {}),
  });
const as = (who: string, method: "GET" | "POST", path: string, payload?: object) =>
  app.inject({
    method,
    url: `/v1/venues/${venueId}${path}`,
    headers: { "x-test-as": who },
    ...(payload ? { payload } : {}),
  });
async function tablet(method: "GET" | "POST", url: string, body?: object) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const headers = await signDeviceRequest({
    deviceId: ids["dev_tablet_room_9"]!,
    privateKey: tabletKey.privateKey,
    method,
    path: url,
    body: payload,
  });
  return app.inject({
    method,
    url,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { payload } : {}),
  });
}
let room9Guest = "";

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
  // Every phone subscribed to push: the owner's, the manager's, the bartender's and the front desk's.
  for (const who of ["abhishek", "andy", "maya", "diego"]) {
    const phone = await raw.query<{ id: string }>(
      "insert into devices (venue_id, kind, name, user_id, public_key) values ($1, 'staff_phone', $2, $3, '{}') returning id",
      [venueId, `${who}'s phone`, ids[who]],
    );
    await raw.query(
      `insert into push_subscriptions (venue_id, device_id, endpoint, keys) values ($1, $2, $3, '{"p256dh":"k","auth":"a"}')`,
      [venueId, phone.rows[0]!.id, `https://push.example.test/${who}`],
    );
  }
  const roles = { abhishek: "owner", andy: "manager", maya: "bartender", diego: "front_desk" };
  for (const [who, role] of Object.entries(roles))
    people[who] = {
      kind: "user",
      userId: ids[who]!,
      session: role === "owner" || role === "manager" ? "passkey" : "pin",
      memberships: [{ venueId, membershipId: ids[`${who}.membership`]!, role }],
    } as Principal;
  tabletKey = await makeDeviceKey();
  await raw.query("update devices set public_key = $2 where id = $1", [
    ids["dev_tablet_room_9"],
    JSON.stringify(tabletKey.publicJwk),
  ]);
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [
      async (request) => {
        const who = request.headers["x-test-as"];
        return typeof who === "string" ? people[who] : undefined;
      },
    ],
    moduleCacheMs: 0,
  });
  await app.ready();
  room9Guest = cookieOf(
    (
      await app.inject({
        method: "POST",
        url: "/v1/public/room-session/host",
        payload: { token: seedHostToken("sess_room9") },
      })
    ).headers["set-cookie"],
  );
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await raw.end();
  await db.drop();
});

type Incident = {
  id: string;
  kind: string;
  room_name: string | null;
  at: string;
  status: string;
  acknowledged_by: string | null;
  closed_at: string | null;
  keep_until: string | null;
  notes: { text: string; added_by: string }[];
};
const managerNeeded = async () =>
  (await as("andy", "GET", "/board")).json<{ manager_needed: number | null }>().manager_needed;

describe("the private help alert and the incident log", () => {
  it("the link shows on a guest's own phone, never on Room 9's tablet, and the tablet can't send one", async () => {
    expect((await guest(room9Guest, "GET", "")).json()).toMatchObject({ help_link: true });
    const view = await tablet("GET", "/v1/public/room-session");
    expect(view.json()).toMatchObject({ tablet: true, help_link: false });
    const sent = await tablet("POST", "/v1/public/room-session/help", { kind: "unsafe" });
    expect([401, 403]).toContain(sent.statusCode);
    expect(await managerNeeded()).toBe(0);
  });

  it("a guest in Room 9 taps it: Andy's and Abhishek's phones get Room 9, the time and the kind; Maya's and Diego's nothing", async () => {
    const r = await guest(room9Guest, "POST", "/help", { kind: "unsafe" });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ sent: true });
    const sender = new FakePushSender();
    const ownerPool = new pg.Pool({ connectionString: db.url, max: 2 });
    const worker = new Worker(ownerPool, {
      pool: "normal",
      handlers: { [PUSH_SEND_KIND]: makePushSendHandler(sender) },
      clock,
      random: () => 0.5,
    });
    while ((await worker.tick()) > 0);
    await ownerPool.end();
    expect(sender.sent.map((s) => s.endpoint).sort()).toEqual([
      "https://push.example.test/abhishek",
      "https://push.example.test/andy",
    ]);
    for (const s of sender.sent)
      expect(JSON.parse(s.payload).body).toBe(
        "Manager needed · Room 9 · 10:41 PM · A guest feels unsafe",
      );
    // A second tap while it's open answers the same incident, with no second push.
    expect((await guest(room9Guest, "POST", "/help", { kind: "other" })).statusCode).toBe(201);
    const count = await raw.query<{ n: number }>(
      "select count(*)::int as n from incidents where venue_id = $1",
      [venueId],
    );
    expect(count.rows[0]!.n).toBe(1);
  });

  it("incident.opened reaches managers only; the board's channel gets only the count, never a room or reason", async () => {
    const events = (
      await raw.query<StampedEvent>(
        "select * from venue_events where venue_id = $1 and type like 'incident.%' order by seq",
        [venueId],
      )
    ).rows;
    expect(events.map((e) => [e.type, e.audience, e.room_id])).toEqual([
      ["incident.opened", "managers", null],
      ["incident.count", "staff", null],
    ]);
    const [opened, count] = events as [StampedEvent, StampedEvent];
    expect(count.entity_id).toBe(venueId);
    expect(count.entity_version).toBe(1);
    const bar: Principal = {
      kind: "device",
      deviceId: ids["dev_bar"] ?? "bar",
      venueId,
      deviceKind: "bar_computer",
    };
    const tabletP: Principal = {
      kind: "device",
      deviceId: ids["dev_tablet_room_9"]!,
      venueId,
      deviceKind: "room_tablet",
    };
    const guestP: Principal = { kind: "guest", venueId, scope: "room_session", id: "g" };
    const room9 = ids["room_9"];
    for (const p of [bar, people["maya"]!, people["diego"]!])
      expect(visibleTo({ principal: p, venueId }, opened)).toBe(false);
    for (const p of [people["andy"]!, people["abhishek"]!])
      expect(visibleTo({ principal: p, venueId }, opened)).toBe(true);
    expect(visibleTo({ principal: bar, venueId }, count)).toBe(true);
    for (const p of [tabletP, guestP])
      for (const e of events)
        expect(visibleTo({ principal: p, venueId, roomId: room9 }, e)).toBe(false);

    const board = await as("maya", "GET", "/board");
    expect(board.statusCode).toBe(200);
    expect(board.json<{ manager_needed: number }>().manager_needed).toBe(1);
    expect(board.body).not.toContain(opened.entity_id);
    expect(board.body).not.toMatch(/unsafe/);
  });

  it("a bartender's or front-desk session can't read or touch any incident", async () => {
    const id = (await raw.query<{ id: string }>("select id from incidents")).rows[0]!.id;
    for (const who of ["maya", "diego"]) {
      expect((await as(who, "GET", "/incidents")).statusCode).toBe(403);
      for (const action of ["ack", "close"])
        expect((await as(who, "POST", `/incidents/${id}/${action}`)).statusCode).toBe(403);
      expect((await as(who, "POST", `/incidents/${id}/notes`, { text: "x" })).statusCode).toBe(403);
      expect((await as(who, "POST", "/incidents", { kind: "other", note: "x" })).statusCode).toBe(
        403,
      );
    }
  });

  it("Andy takes it, adds a note and closes it: the pin clears and it's kept 3 years", async () => {
    const list = (await as("andy", "GET", "/incidents")).json<{ incidents: Incident[] }>()
      .incidents;
    expect(list).toHaveLength(1);
    const help = list[0]!;
    expect(help).toMatchObject({ kind: "unsafe", room_name: "Room 9", status: "open" });
    expect(Math.abs(Temporal.Instant.from(help.at).since(SEED_NOW).total("second"))).toBeLessThan(
      60,
    );

    const ack = await as("andy", "POST", `/incidents/${help.id}/ack`);
    expect(ack.json<{ incident: Incident }>().incident).toMatchObject({
      status: "acknowledged",
      acknowledged_by: ids["andy"],
    });
    expect(await managerNeeded()).toBe(1);
    const note = await as("andy", "POST", `/incidents/${help.id}/notes`, {
      text: "Spoke with the guest; her friend walked her to a cab.",
    });
    expect(note.statusCode, note.body).toBe(201);
    clock.advance(Temporal.Duration.from({ minutes: 12 }));
    const closed = (await as("andy", "POST", `/incidents/${help.id}/close`)).json<{
      incident: Incident;
    }>().incident;
    expect(closed.status).toBe("closed");
    expect(closed.notes.map((n) => [n.text, n.added_by])).toEqual([
      ["Spoke with the guest; her friend walked her to a cab.", ids["andy"]],
    ]);
    // Kept 3 years from the close, in New York time.
    expect(Temporal.Instant.from(closed.keep_until!).toString()).toBe(
      Temporal.Instant.from(closed.closed_at!)
        .toZonedDateTimeISO("America/New_York")
        .add({ years: 3 })
        .toInstant()
        .toString(),
    );
    expect(closed.keep_until!.slice(0, 10)).toBe("2029-09-26");
    expect(await managerNeeded()).toBe(0);
    // The app can't delete an incident or edit a note.
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.venue_id', $1, true)", [venueId]);
      await expect(c.query("delete from incidents")).rejects.toThrow(/permission denied/);
      await c.query("rollback");
      await c.query("begin");
      await c.query("select set_config('app.venue_id', $1, true)", [venueId]);
      await expect(c.query("update incident_notes set text = 'x'")).rejects.toThrow(
        /permission denied/,
      );
      await c.query("rollback");
    } finally {
      c.release();
    }
    // The guest can ask again once it's closed.
    expect((await guest(room9Guest, "POST", "/help", { kind: "other" })).statusCode).toBe(201);
    expect(await managerNeeded()).toBe(1);
  });

  it("a manager logs one by hand, with its first note, and a room from another venue's id is refused", async () => {
    const r = await as("abhishek", "POST", "/incidents", {
      kind: "someone_needs_help",
      room_id: ids["room_5"],
      note: "A guest slipped by the bar; first aid given.",
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json<{ incident: Incident }>().incident).toMatchObject({
      room_name: "Room 5",
      status: "open",
      notes: [{ text: "A guest slipped by the bar; first aid given.", added_by: ids["abhishek"] }],
    });
    const stranger = await as("abhishek", "POST", "/incidents", {
      kind: "other",
      room_id: "00000000-0000-4000-8000-000000000001",
      note: "x",
    });
    expect(stranger.statusCode).toBe(404);
    expect(
      (await as("andy", "POST", "/incidents/00000000-0000-4000-8000-000000000002/ack")).statusCode,
    ).toBe(404);
  });

  it("with Safety & ID records off the link, the pin and the log hide and the routes answer module_off", async () => {
    await raw.query(
      "update venue_modules set state = 'off' where venue_id = $1 and module_id = 'safety'",
      [venueId],
    );
    expect((await guest(room9Guest, "GET", "")).json()).toMatchObject({ help_link: false });
    const help = await guest(room9Guest, "POST", "/help", { kind: "unsafe" });
    expect(help.statusCode).toBe(404);
    expect(help.json()).toMatchObject({ error: { code: "module_off" } });
    expect((await as("andy", "GET", "/incidents")).json()).toMatchObject({
      error: { code: "module_off" },
    });
    expect(await managerNeeded()).toBeNull();
    await raw.query(
      "update venue_modules set state = 'on' where venue_id = $1 and module_id = 'safety'",
      [venueId],
    );
  });
});
