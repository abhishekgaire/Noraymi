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

  it("P-08 · the Month view: September's counts match each day's list, and a past day can't take a booking", async () => {
    const month = (await req("GET", "/bookings/days?from=2026-09-01&days=30")).json<{
      tonight: string;
      days: { business_date: string; bookings: number }[];
    }>();
    expect(month.tonight).toBe("2026-09-25");
    expect(month.days).toHaveLength(30);
    expect(month.days[0]!.business_date).toBe("2026-09-01");
    expect(month.days[29]!.business_date).toBe("2026-09-30");
    for (const d of month.days) {
      const list = (await req("GET", `/bookings?business_date=${d.business_date}`)).json<{
        bookings: { status: string }[];
      }>().bookings;
      const live = list.filter((b) => b.status !== "cancelled" && b.status !== "no_show");
      expect(live.length, d.business_date).toBe(d.bookings);
    }
    expect(month.days.find((d) => d.business_date === "2026-09-25")!.bookings).toBe(11);
    const past = await req("POST", "/bookings", {
      guest: { name: "Test Party" },
      party_size: 4,
      business_date: "2026-09-20",
      time: "21:00",
      hours: 2,
    });
    expect(past.json()).toMatchObject({ error: { details: { reason: "past" } } });
    for (const bad of ["2026-13-01", "Sept", "2026-02-30"])
      expect((await req("GET", `/bookings/days?from=${bad}`)).statusCode, bad).toBe(400);
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
