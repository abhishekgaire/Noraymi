import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/** M2-33 acceptance on the demo seed at 10:41 PM. */
let db: TestDatabase;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
const req = (method: "GET" | "POST", path: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/v1/venues/${venueId}${path}`,
    ...(payload === undefined ? {} : { payload: payload as never }),
  });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  const raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  ids = Object.fromEntries(
    (
      await raw.query<{ slug: string; id: string }>(
        "select slug, row_id as id from seed_ids where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.slug, r.id]),
  );
  await raw.end();
  const andy: Principal = {
    kind: "user",
    userId: ids["andy"]!,
    session: "passkey",
    memberships: [{ venueId, membershipId: ids["andy.membership"]!, role: "manager" }],
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

describe("the Calendar", () => {
  it("starts from Tonight, Fri Sep 25, with its 11 bookings and not Leo M.'s walk-in", async () => {
    const days = (await req("GET", "/bookings/days?days=7")).json<{
      tonight: string;
      days: { business_date: string; bookings: number }[];
    }>();
    expect(days.tonight).toBe("2026-09-25");
    expect(days.days[0]).toMatchObject({ business_date: "2026-09-25", bookings: 11 });
    const list = (await req("GET", "/bookings?business_date=2026-09-25")).json<{
      bookings: { guest_name: string }[];
    }>().bookings;
    expect(list).toHaveLength(11);
    expect(list.map((b) => b.guest_name)).not.toContain("Leo M.");
  });

  it("refuses a VIP-room booking at 11:00 PM tonight (Bianca L. holds it until 12:30 AM) and one at 9:00 PM (past)", async () => {
    const body = (time: string) => ({
      guest: { name: "Test Party" },
      party_size: 22,
      business_date: "2026-09-25",
      time,
      hours: 2,
      room_id: ids["room_vip"],
    });
    const vip = await req("POST", "/bookings", body("23:00"));
    expect(vip.statusCode).toBe(409);
    expect(vip.json()).toMatchObject({ error: { code: "room_not_free" } });
    const past = await req("POST", "/bookings", body("21:00"));
    expect(past.json()).toMatchObject({ error: { details: { reason: "past" } } });
  });

  it("blocking Sat Sep 26 shows it closed, and the day's bookings are the ones it affects", async () => {
    const sat = (await req("GET", "/bookings?business_date=2026-09-26")).json<{
      bookings: unknown[];
    }>().bookings;
    const blocked = await req("POST", "/closures", { date: "2026-09-26", kind: "closed" });
    expect(blocked.statusCode, blocked.body).toBe(201);
    const days = (await req("GET", "/bookings/days?days=3")).json<{
      days: { business_date: string; bookings: number; closure: string | null }[];
    }>();
    expect(days.days[1]).toMatchObject({
      business_date: "2026-09-26",
      closure: "closed",
      bookings: sat.length,
    });
  });
});
