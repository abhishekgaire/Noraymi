import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import {
  SEED_NOW,
  SimulatedClock,
  Temporal,
  makeDeviceKey,
  signDeviceRequest,
} from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { SoftwarePasskey } from "../auth/test-passkey.js";

/**
 * M2-16 acceptance on the demo seed and the simulated clock: Diego asks for a
 * clock pause from the front-desk computer in his PIN session, it waits for
 * Andy, Andy approves on his own phone, and the clock stops billing from that
 * minute; comps of 15 minutes in Rooms 5 and 9; Room 4's fault on its tile.
 */
const ORIGIN = "http://localhost:5173";
const ANDY = "andy@demo.west4.local";
let db: TestDatabase;
let raw: pg.Client;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
let andyCookie = "";
let diegoAuth: Record<string, string> = {};
type Device = { id: string; key: Awaited<ReturnType<typeof makeDeviceKey>> };
let andyPhone: Device;
let desk: Device;
const clock = new SimulatedClock(SEED_NOW);
const at = (hhmm: string, day = "2026-09-25") => Temporal.Instant.from(`${day}T${hhmm}:00-04:00`);
const v = (path: string) => `/v1/venues/${venueId}${path}`;
type Json = Record<string, unknown> & { error?: { code: string; message: string } };
const json = (r: { body: string }) => JSON.parse(r.body) as Json;

async function signed(
  device: Device,
  method: "POST" | "GET",
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const sig = await signDeviceRequest({
    deviceId: device.id,
    privateKey: device.key.privateKey,
    method,
    path,
    body: payload,
  });
  return app.inject({
    method,
    url: path,
    headers: {
      ...sig,
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { payload }),
  });
}
async function device(kind: string, userId: string | null): Promise<Device> {
  const key = await makeDeviceKey();
  const r = await raw.query<{ id: string }>(
    "insert into devices (venue_id, kind, name, user_id, public_key) values ($1, $2, $3, $4, $5) returning id",
    [venueId, kind, `${kind} test`, userId, JSON.stringify(key.publicJwk)],
  );
  return { id: r.rows[0]!.id, key };
}
const asDiego = (method: "POST" | "GET" | "PATCH", path: string, payload?: unknown) =>
  app.inject({
    method,
    url: v(path),
    headers: diegoAuth,
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
const asAndy = (method: "POST" | "GET" | "PATCH", path: string, payload?: unknown) =>
  app.inject({
    method,
    url: v(path),
    headers: { cookie: andyCookie },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
const session = async (slug: string) =>
  json(await asAndy("GET", `/sessions/${ids[slug]}`))["session"] as {
    room_time_cents: number;
    minutes: number;
    segments: { paused: boolean; started_at: string }[];
  };
const room = async (name: string) =>
  (json(await asAndy("GET", "/rooms/availability"))["rooms"] as Record<string, unknown>[]).find(
    (r) => r["name"] === name,
  )!;

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
  app = buildApp({
    config: loadConfig({
      WEST4_ENV: "local",
      DATABASE_URL: db.url,
      APP_DATABASE_URL: db.url,
      WEBAUTHN_RP_ID: "localhost",
      WEBAUTHN_ORIGINS: ORIGIN,
    }),
    clock,
    moduleCacheMs: 0,
  });
  await app.ready();
  const passkey = new SoftwarePasskey("localhost");
  await raw.query("delete from auth_credentials where user_id = $1", [ids["andy"]]);
  const post = (url: string, payload: unknown) =>
    app.inject({ method: "POST", url, payload: payload as never });
  expect((await post("/v1/auth/enroll", { step: "start", email: ANDY })).statusCode).toBe(200);
  const code = (
    await raw.query<{ payload: { data: { code: string } } }>(
      "select payload from jobs where kind = 'email.send' and payload->>'to' = $1 order by created_at desc limit 1",
      [ANDY],
    )
  ).rows[0]!.payload.data.code;
  const opts = json(await post("/v1/auth/enroll", { step: "passkey_options", email: ANDY, code }));
  const done = await post("/v1/auth/enroll", {
    step: "passkey_finish",
    email: ANDY,
    code,
    credential: passkey.register(opts["options"] as { challenge: string }, ORIGIN),
    name: "Andy's phone",
    client: "web",
  });
  expect(done.statusCode, done.body).toBe(201);
  const cookie = done.headers["set-cookie"];
  andyCookie = String(Array.isArray(cookie) ? cookie[0] : cookie).split(";")[0]!;
  andyPhone = await device("staff_phone", ids["andy"]!);
  desk = await device("front_desk", null);
  const pin = await signed(desk, "POST", "/v1/auth/pin", {
    membership_id: ids["diego.membership"],
    pin: "6358",
    client: "shared",
  });
  expect(pin.statusCode, pin.body).toBe(200);
  diegoAuth = { authorization: `Bearer ${json(pin)["token"] as string}` };
});

afterAll(async () => {
  await app.close();
  await raw.end();
  await db.drop();
});

describe("faults and the room clock", () => {
  it("Room 4 shows Out of service with its note, logged Tue Sep 22, and its tablet is off", async () => {
    const r4 = await room("Room 4");
    expect(r4).toMatchObject({ state: "out_of_service", tablet_on: false });
    expect(r4["faults"]).toEqual([
      expect.objectContaining({
        text: "Mic dead since Tue. Replacement ordered.",
        out_of_service: true,
      }),
    ]);
    const f = (r4["faults"] as { reported_at: string }[])[0]!;
    expect(
      Temporal.Instant.from(f.reported_at)
        .toZonedDateTimeISO("America/New_York")
        .toPlainDate()
        .toString(),
    ).toBe("2026-09-22");
    expect((await room("Room 5"))["tablet_on"]).toBe(true);
  });

  it("Diego's pause from the front desk waits for Andy, only on Andy's phone; Andy approves and Room 9 stops billing from that minute", async () => {
    clock.set(at("22:50"));
    const asked = await asDiego("POST", `/sessions/${ids["sess_room9"]}/pause`, {
      reason: "Mic dead, swapping it",
    });
    expect(asked.statusCode, asked.body).toBe(202);
    expect(json(asked)).toMatchObject({
      status: "approval_pending",
      waiting_for: { name: "Andy C." },
    });
    const id = json(asked)["approval_id"] as string;
    const row = (
      await raw.query("select routed_to, requested_device_id from approvals where id = $1", [id])
    ).rows[0];
    expect(row).toEqual({ routed_to: ids["andy"], requested_device_id: desk.id });
    const pushes = await raw.query<{ who: string }>(
      "select payload->'audience'->>'user_id' as who from jobs where kind = 'push.send' and payload->'message'->>'tag' = $1",
      [`approval-${id}`],
    );
    expect(pushes.rows).toEqual([{ who: ids["andy"] }]);
    // Not from the front desk: Diego can't, and the front-desk computer isn't Andy's phone.
    expect(
      (await signed(desk, "POST", v(`/approvals/${id}/decide`), { decision: "approve" }, diegoAuth))
        .statusCode,
    ).toBe(403);
    const before = await session("sess_room9");
    clock.set(at("22:52").add({ seconds: 20 }));
    const ok = await signed(
      andyPhone,
      "POST",
      v(`/approvals/${id}/decide`),
      { decision: "approve" },
      { cookie: andyCookie },
    );
    expect(ok.statusCode, ok.body).toBe(200);
    const paused = await session("sess_room9");
    const last = paused.segments.at(-1)!;
    expect(last.paused).toBe(true);
    expect(Temporal.Instant.from(last.started_at).toString()).toBe(at("22:52").toString());
    const seg = (
      await raw.query("select approved_by, reason from session_segments where id = $1", [
        (last as unknown as { id: string }).id,
      ])
    ).rows[0];
    expect(seg).toEqual({ approved_by: ids["andy"], reason: "Mic dead, swapping it" });
    expect(paused.room_time_cents).toBeGreaterThan(before.room_time_cents);
    clock.set(at("23:20"));
    expect((await session("sess_room9")).room_time_cents).toBe(paused.room_time_cents);
    // Unpause: billing starts again from that minute.
    expect((await asDiego("POST", `/sessions/${ids["sess_room9"]}/unpause`)).statusCode).toBe(200);
    clock.set(at("23:30"));
    expect((await session("sess_room9")).room_time_cents).toBe(paused.room_time_cents + 2000);
  });

  it("Andy's own pause request goes to Abhishek", async () => {
    const r = await asAndy("POST", `/sessions/${ids["sess_room1"]}/pause`, { reason: "TV dead" });
    expect(r.statusCode).toBe(202);
    expect(json(r)["waiting_for"]).toMatchObject({ name: "Abhishek G." });
  });

  it("Comp 15 min writes −$10.00 at once in Room 5, and $30.00 waits for approval in Room 9", async () => {
    const r5 = await asDiego("POST", `/sessions/${ids["sess_room5"]}/comp-minutes`, {
      reason: "Mic cut out",
    });
    expect(r5.statusCode, r5.body).toBe(201);
    expect(json(r5)).toMatchObject({ status: "added", amount_cents: 1000 });
    const line = (
      await raw.query(
        "select amount_cents::int as amount, reason, tax_category, approved_by, source_id is not null as has_source from check_lines where id = $1",
        [json(r5)["line_id"]],
      )
    ).rows[0];
    expect(line).toEqual({
      amount: -1000,
      reason: "Mic cut out",
      tax_category: "room_time",
      approved_by: null,
      has_source: true,
    });
    const r9 = await asDiego("POST", `/sessions/${ids["sess_room9"]}/comp-minutes`, {
      reason: "Mic cut out",
    });
    expect(r9.statusCode).toBe(202);
    expect(json(r9)).toMatchObject({
      status: "approval_pending",
      waiting_for: { name: "Andy C." },
    });
    expect(
      (
        await raw.query("select amount_cents from approvals where id = $1", [
          json(r9)["approval_id"],
        ])
      ).rows[0],
    ).toEqual({ amount_cents: "3000" });
  });

  it("a fault logged with comp 15 min links its comp line, shows on the tile, and Fixed takes it off", async () => {
    const r = await asDiego("POST", `/rooms/${ids["room_5"]}/faults`, {
      text: "Song system froze",
      comp_minutes: 15,
    });
    expect(r.statusCode, r.body).toBe(201);
    const fault = json(r)["fault"] as { id: string; comp_line_id: number };
    expect(fault.comp_line_id).toBe((json(r)["comp"] as { line_id: number }).line_id);
    expect(((await room("Room 5"))["faults"] as { id: string }[]).map((f) => f.id)).toEqual([
      fault.id,
    ]);
    expect((await asDiego("PATCH", `/faults/${fault.id}`, { fixed: true })).statusCode).toBe(200);
    expect((await room("Room 5"))["faults"]).toEqual([]);
  });

  it("out of service takes a room off with an out_of_service block and its tablet off; fixing it frees the room", async () => {
    const r = await asAndy("POST", `/rooms/${ids["room_11"]}/faults`, {
      text: "Speaker blown",
      out_of_service: true,
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(json(r)["reassigned"]).toEqual({ moved: [], unplaced: [] });
    const r11 = await room("Room 11");
    expect(r11).toMatchObject({
      state: "out_of_service",
      tablet_on: false,
      free_now: false,
      current: { kind: "out_of_service" },
    });
    const id = (json(r)["fault"] as { id: string }).id;
    const fixed = await asAndy("PATCH", `/faults/${id}`, { fixed: true });
    expect(fixed.statusCode, fixed.body).toBe(200);
    expect(await room("Room 11")).toMatchObject({
      state: "available",
      tablet_on: true,
      free_now: true,
      faults: [],
    });
    // Room 4's fault fixed: back in service.
    const r4 = (await room("Room 4"))["faults"] as { id: string }[];
    expect((await asAndy("PATCH", `/faults/${r4[0]!.id}`, { fixed: true })).statusCode).toBe(200);
    expect(await room("Room 4")).toMatchObject({ state: "available", tablet_on: true, faults: [] });
  });
});
