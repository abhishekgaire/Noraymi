import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, publishRulePack } from "@west4/db";
import {
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, Temporal, newYorkCounty } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

let db: TestDatabase;
let v: TwoVenues;
let app: FastifyInstance;
const clock = new FrozenClock(SEED_NOW);
const weekly = [0, 1, 2, 3, 4, 5, 6].map((day) => ({
  day,
  opens: day === 0 || day === 6 ? "14:00" : "16:00",
  closes: "04:00",
}));

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  const owner = new pg.Client({ connectionString: db.url });
  await owner.connect();
  await publishRulePack(owner, {
    pack: newYorkCounty,
    effectiveOn: "2026-09-01",
    approvedBy: ["A", "B"],
    privateKeyPem: generateSigningKey().privateKeyPem,
  });
  await owner.end();
  const andy: Principal = {
    kind: "user",
    userId: v.ownerA,
    session: "passkey",
    memberships: [{ venueId: v.venueA, membershipId: v.membershipA, role: "owner" }],
  };
  const config = loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url });
  app = buildApp({ config, clock, authenticators: [async () => andy], eventsPollMs: 100 });
  await app.ready();
  await app.inject({
    method: "PUT",
    url: `/v1/venues/${v.venueA}/settings/hours`,
    payload: { value: { weekly, lastCall: "04:00" } },
  });
});

afterAll(async () => {
  await app.close();
  await db.drop();
});

describe("closures and hours", () => {
  it("POST /closures adds a special date and a closed date; a second row for the same date is refused", async () => {
    const special = await app.inject({
      method: "POST",
      url: `/v1/venues/${v.venueA}/closures`,
      payload: { date: "2026-12-24", kind: "special", closes: "23:00", note: "Christmas Eve" },
    });
    expect(special.statusCode).toBe(201);
    expect(special.json()).toMatchObject({
      date: "2026-12-24",
      kind: "special",
      opens: null,
      closes: "23:00",
      note: "Christmas Eve",
    });
    const closed = await app.inject({
      method: "POST",
      url: `/v1/venues/${v.venueA}/closures`,
      payload: { date: "2026-12-25", kind: "closed" },
    });
    expect(closed.statusCode).toBe(201);
    const dup = await app.inject({
      method: "POST",
      url: `/v1/venues/${v.venueA}/closures`,
      payload: { date: "2026-12-25", kind: "closed" },
    });
    expect(dup.statusCode).toBe(400);
    expect(dup.json().error.message).toContain("2026-12-25 already has a closure");
    const bad = await app.inject({
      method: "POST",
      url: `/v1/venues/${v.venueA}/closures`,
      payload: { date: "2026-12-26", kind: "special" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("GET /closures lists them in date order with a cursor, and only this venue's", async () => {
    const list = await app.inject({
      method: "GET",
      url: `/v1/venues/${v.venueA}/closures?limit=1`,
    });
    expect(list.json().items.map((c: { date: string }) => c.date)).toEqual(["2026-12-24"]);
    expect(list.json().next_cursor).toBe("2026-12-24");
    const next = await app.inject({
      method: "GET",
      url: `/v1/venues/${v.venueA}/closures?limit=1&after=2026-12-24`,
    });
    expect(next.json().items.map((c: { date: string }) => c.date)).toEqual(["2026-12-25"]);
    expect(next.json().next_cursor).toBeNull();
    const other = await app.inject({ method: "GET", url: `/v1/venues/${v.venueB}/closures` });
    expect(other.statusCode).toBe(403);
  });

  it("GET /hours gives tonight's opening, close and last call as instants, and open_now from the venue's clock", async () => {
    const tonight = await app.inject({ method: "GET", url: `/v1/venues/${v.venueA}/hours` });
    expect(tonight.json()).toMatchObject({
      business_date: "2026-09-25",
      closed: false,
      opens: "2026-09-25T16:00:00-04:00",
      closes: "2026-09-26T04:00:00-04:00",
      last_call: "2026-09-26T04:00:00-04:00",
      open_now: true,
      source: "weekly",
    });
    clock.set(Temporal.Instant.from("2026-09-26T08:30:00Z")); // 4:30 AM, still business date Sep 25
    const late = await app.inject({ method: "GET", url: `/v1/venues/${v.venueA}/hours` });
    expect(late.json()).toMatchObject({ business_date: "2026-09-25", open_now: false });
    clock.set(SEED_NOW);
    const xmas = await app.inject({
      method: "GET",
      url: `/v1/venues/${v.venueA}/hours?business_date=2026-12-24`,
    });
    expect(xmas.json()).toMatchObject({
      closes: "2026-12-24T23:00:00-05:00",
      last_call: "2026-12-24T23:00:00-05:00",
      source: "special",
    });
    const closedDay = await app.inject({
      method: "GET",
      url: `/v1/venues/${v.venueA}/hours?business_date=2026-12-25`,
    });
    expect(closedDay.json()).toMatchObject({
      closed: true,
      opens: null,
      closes: null,
      source: "closed",
      open_now: false,
    });
  });
});
