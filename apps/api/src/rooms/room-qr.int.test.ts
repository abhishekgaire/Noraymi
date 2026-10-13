import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed, withVenue } from "@west4/db";
import { createTestDatabase, appPool, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { rotateForWrongCodes } from "./room-code.js";
import { printRoomQr } from "./room-qr.js";

/**
 * F-07 (D124): a room start prints the join QR slip (and emails it to a host with an email) while
 * Ordering from the room is on; Reprint QR prints the current code, the new one after a change;
 * Email it again sends it again; nothing while Ordering from the room is off.
 */
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);

const post = (path: string, payload: unknown) =>
  app.inject({ method: "POST", url: `/v1/venues/${venueId}${path}`, payload: payload as never });
const slips = async () =>
  (
    await raw.query<{ payload: { url: string; code: string; room: string }; reprint_n: number }>(
      "select payload, reprint_n from print_jobs where kind = 'room_qr' order by created_at, reprint_n",
    )
  ).rows;
const qrEmails = async () =>
  (
    await raw.query<{ payload: { to: string; data: { joinUrl: string; code: string } } }>(
      "select payload from jobs where kind = 'email.send' and payload->>'template' = 'room_qr' order by created_at",
    )
  ).rows.map((r) => r.payload);

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
  const andy: Principal = {
    kind: "user",
    userId: ids["andy"]!,
    session: "passkey",
    memberships: [{ venueId, membershipId: ids["andy.membership"]!, role: "manager" }],
  };
  app = buildApp({
    config: loadConfig({
      WEST4_ENV: "local",
      DATABASE_URL: db.url,
      APP_DATABASE_URL: db.url,
      GUEST_APP_URL: "https://guest.test",
    }),
    clock,
    authenticators: [async () => andy],
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

describe("the room's join QR (F-07)", () => {
  let sessionId = "";

  it("a walk-in prints the slip and emails the host the same link with the code", async () => {
    const r = await post(`/rooms/${ids["room_11"]}/sessions`, {
      party_size: 4,
      ids_checked: 4,
      minutes: 60,
      guest: { name: "Sam O.", email: "sam@example.test" },
    });
    expect(r.statusCode, r.body).toBe(201);
    const seated = JSON.parse(r.body) as {
      session_id: string;
      room_code: string;
      qr: { printed: boolean; emailed: string | null };
    };
    sessionId = seated.session_id;
    expect(seated.qr).toEqual({ printed: true, emailed: "sam@example.test" });
    const [slip] = await slips();
    expect(slip!.payload).toMatchObject({ room: "Room 11", code: seated.room_code });
    expect(slip!.payload.url).toBe(
      `https://guest.test/v/west4karaoke/room/${ids["room_11"]}?code=${seated.room_code}`,
    );
    expect(slip!.reprint_n).toBe(0);
    const [mail] = await qrEmails();
    expect(mail).toMatchObject({ to: "sam@example.test", data: { code: seated.room_code } });
  });

  it("Reprint QR prints the current code, and the new one after the code changes", async () => {
    const again = await post(`/sessions/${sessionId}/qr`, {});
    expect(JSON.parse(again.body)).toMatchObject({ printed: true, reprint_n: 1 });
    await withVenue(pool, { venueId }, (c) =>
      rotateForWrongCodes(
        c,
        venueId,
        { id: sessionId, roomId: ids["room_11"]!, roomName: "Room 11" },
        clock.now(),
      ),
    );
    const after = await post(`/sessions/${sessionId}/qr`, { email: true });
    expect(JSON.parse(after.body)).toMatchObject({
      printed: true,
      reprint_n: 2,
      emailed: "sam@example.test",
    });
    const all = await slips();
    expect(all).toHaveLength(3);
    expect(all[2]!.payload.code).not.toBe(all[0]!.payload.code);
    const mails = await qrEmails();
    expect(mails).toHaveLength(2);
    expect(mails[1]!.data.code).toBe(all[2]!.payload.code);
  });

  it("with Ordering from the room off, no slip prints and the route answers module_off (a room start prints none the same way)", async () => {
    await raw.query(
      "update venue_modules set state = 'off' where venue_id = $1 and module_id = 'room_ordering'",
      [venueId],
    );
    const before = (await slips()).length;
    const none = await withVenue(pool, { venueId }, (c) =>
      printRoomQr(c, venueId, sessionId, { now: clock.now(), guestAppUrl: "https://guest.test" }),
    );
    expect(none).toBeNull();
    expect(await slips()).toHaveLength(before);
    const off = await post(`/sessions/${sessionId}/qr`, {});
    expect(JSON.parse(off.body).error.code).toBe("module_off");
  });
});
