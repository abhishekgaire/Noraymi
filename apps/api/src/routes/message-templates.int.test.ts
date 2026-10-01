import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { loadDemoSeed, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { queueText } from "../texts/queue.js";

/** M2-10: exactly the spec's 14 texts in order, West 4's wording, Reminder off stops it, marketing stays off. */
const SPEC_14 = [
  "booking_confirmed",
  "reminder",
  "room_code",
  "room_ready",
  "offer_expiring",
  "please_wrap_up",
  "booked_time_ending",
  "receipt",
  "deposit_refund",
  "payment_link",
  "running_late_reply",
  "up_next",
  "review_ask",
  "birthday",
];

let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
const clock = new SimulatedClock(SEED_NOW);
const call = (method: "GET" | "PATCH", path: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/v1/venues/${venueId}${path}`,
    ...(payload === undefined ? {} : { payload: payload as never }),
  });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  pool = appPool(db.url);
  const m =
    (await pool.query("select 1")) &&
    (
      await withVenue(pool, { venueId }, (c) =>
        c.query<{ id: string; user_id: string }>(
          "select id, user_id from memberships where venue_id = $1 and role = 'manager'",
          [venueId],
        ),
      )
    ).rows[0]!;
  const andy: Principal = {
    kind: "user",
    userId: m.user_id,
    session: "passkey",
    memberships: [{ venueId, membershipId: m.id, role: "manager" }],
  };
  const config = loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url });
  app = buildApp({ config, clock, authenticators: [async () => andy], moduleCacheMs: 0 });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe("Admin → Texts", () => {
  it("lists exactly the 14 texts in the spec's order, with West 4's wording", async () => {
    const r = await call("GET", "/message-templates");
    expect(r.statusCode, r.body).toBe(200);
    const list = (
      r.json() as {
        templates: {
          key: string;
          position: number;
          category: string;
          on: boolean;
          example: string;
        }[];
      }
    ).templates;
    expect(list.map((t) => t.key)).toEqual(SPEC_14);
    expect(list.map((t) => t.position)).toEqual(SPEC_14.map((_, i) => i + 1));
    expect(list.filter((t) => t.category === "service")).toHaveLength(12);
    expect(list[0]!.example).toBe(
      "Booked. Room for 6 at 9:30 PM, Sat Sep 26. A 20% gratuity is added to room tabs. Deposit $60 paid, comes off your bill. Free to cancel until Fri 9:30 PM: west4karaoke.com/b/…",
    );
    expect(list[6]!.example).toBe(
      "Your booked time in Room 9 ends at 11:00 PM. Nobody's booked after you, so you can stay on by the minute until we close at 4 AM.",
    );
    expect(list.some((t) => /^On its way|The bar needs a few minutes/.test(t.example ?? ""))).toBe(
      false,
    );
  });

  it("turning Reminder off stops it being sent", async () => {
    expect((await call("PATCH", "/message-templates/reminder", { on: false })).statusCode).toBe(
      200,
    );
    await expect(
      withVenue(pool, { venueId }, (c) =>
        queueText(
          c,
          venueId,
          {
            templateKey: "reminder",
            to: "+13475550177",
            params: { venue: "West 4", party: 6, time: "9:30 PM", address: "186 W 4th St" },
            guestId: null,
            context: null,
            sentBy: null,
            now: clock.now(),
          },
          { allowList: null },
        ),
      ),
    ).rejects.toMatchObject({ details: { reason: "template_off" } });
  });

  it("Review ask and Birthday show off and can't be turned on", async () => {
    const list = (
      (await call("GET", "/message-templates")).json() as {
        templates: { key: string; on: boolean; locked_off: boolean }[];
      }
    ).templates;
    for (const key of ["review_ask", "birthday"])
      expect(list.find((t) => t.key === key)).toMatchObject({ on: false, locked_off: true });
    const r = await call("PATCH", "/message-templates/review_ask", { on: true });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: { message: string } }).error.message).toMatch(
      /Marketing texts is off/,
    );
  });

  it("wording saves with the text's own slots and refuses a slot it doesn't have", async () => {
    const ok = await call("PATCH", "/message-templates/room_ready", {
      body: "Room ready: {room}. Claim it at the front desk within 10 minutes.",
    });
    expect((ok.json() as { template: { example: string } }).template.example).toBe(
      "Room ready: Room 11. Claim it at the front desk within 10 minutes.",
    );
    expect(
      (await call("PATCH", "/message-templates/room_ready", { body: "Hi {name}" })).statusCode,
    ).toBe(400);
  });

  it("the reminder time starts empty for West 4 (D87)", async () => {
    const r = await call("GET", "/settings/messages");
    expect(
      (r.json() as { value: { reminderAt: string | null; offerExpiringMin: number } }).value,
    ).toEqual({ reminderAt: null, offerExpiringMin: 5 });
  });
});
