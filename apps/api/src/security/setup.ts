import pg from "pg";
import { badgeUidHash } from "@west4/db";
import { createTestDatabase, seedTwoVenues, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock } from "@west4/shared";
import type { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { headerAuthenticator, type Cast } from "./fixtures.js";
import type { WallFixtures } from "./wall-suite.js";

/**
 * One database for a security suite: two venues, the cast at venue A, and
 * venue B's rows for every venue-owned route parameter. Tests build the app
 * themselves (the planted-leak test adds routes) with `appOptions`.
 */
export interface SuiteWorld {
  readonly db: TestDatabase;
  readonly owner: pg.Pool;
  readonly cast: Cast & { ownerB: string };
  readonly fixtures: WallFixtures;
  readonly clock: SimulatedClock;
  readonly appOptions: Parameters<typeof buildApp>[0];
  readonly close: () => Promise<void>;
}

const KEY = "c".repeat(64);

export async function suiteWorld(): Promise<SuiteWorld> {
  const db = await createTestDatabase({ migrate: true });
  const v = await seedTwoVenues(db.url);
  const owner = new pg.Pool({ connectionString: db.url, max: 2 });
  const clock = new SimulatedClock(SEED_NOW);
  const person = async (
    venueId: string,
    name: string,
    role: string,
    digits: 4 | 6,
  ): Promise<{ userId: string; membershipId: string }> => {
    const u = await owner.query<{ id: string }>(
      "insert into users (name) values ($1) returning id",
      [name],
    );
    const m = await owner.query<{ id: string }>(
      "insert into memberships (venue_id, user_id, role, status, pin_digits) values ($1, $2, $3, 'active', $4) returning id",
      [venueId, u.rows[0]!.id, role, digits],
    );
    return { userId: u.rows[0]!.id, membershipId: m.rows[0]!.id };
  };
  const managerA = await person(v.venueA, "Andy C.", "manager", 6);
  const bartenderA = await person(v.venueA, "Maya S.", "bartender", 4);
  const frontDeskA = await person(v.venueA, "Diego R.", "front_desk", 4);
  // Venue B's rows, one per venue-owned parameter.
  const staffB = await person(v.venueB, "Someone at B", "bartender", 4);
  const deviceB = await owner.query<{ id: string }>(
    "insert into devices (venue_id, kind, name) values ($1, 'front_desk', 'B desk') returning id",
    [v.venueB],
  );
  const badgeB = await owner.query<{ id: string }>(
    "insert into staff_badges (venue_id, membership_id, uid_hash, label) values ($1, $2, $3, 'B fob') returning id",
    [v.venueB, staffB.membershipId, badgeUidHash(v.venueB, Buffer.from("04B0B0B0B0B0B0", "hex"))],
  );
  const cast: Cast & { ownerB: string } = {
    venueA: v.venueA,
    venueB: v.venueB,
    ownerA: v.ownerA,
    membershipA: v.membershipA,
    managerA,
    bartenderA,
    frontDeskA,
    ownerB: v.ownerB,
  };
  const fixtures: WallFixtures = {
    venueOwned: { m: staffB.membershipId, d: deviceB.rows[0]!.id, b: badgeB.rows[0]!.id },
    bodies: {
      "PATCH /v1/venues/:venueId/team/:m": { locale: "es" },
      "POST /v1/venues/:venueId/team/:m/badges/keys": { uid: "04AABBCCDDEEFF" },
      "POST /v1/venues/:venueId/team/:m/badges": { sun: "https://x.test/?e=00&c=00", label: "x" },
      "PATCH /v1/venues/:venueId/devices/:d": { name: "renamed" },
      "PATCH /v1/venues/:venueId/modules/:id": { state: "off" },
      "PUT /v1/venues/:venueId/settings/:key": { value: { weekly: [], lastCall: null } },
      "PATCH /v1/venues/:venueId/permissions/:role/:action": { allowed: true },
    },
  };
  const config = loadConfig({
    WEST4_ENV: "local",
    DATABASE_URL: db.url,
    APP_DATABASE_URL: db.url,
    AUTH_SECRET_KEY: KEY,
    WEBAUTHN_RP_ID: "localhost",
    WEBAUTHN_ORIGINS: "http://localhost:5173",
  });
  return {
    db,
    owner,
    cast,
    fixtures,
    clock,
    appOptions: {
      config,
      clock,
      authenticators: [headerAuthenticator],
      staffRateLimit: { max: 1_000_000, windowMs: 60_000 },
      moduleCacheMs: 0,
    },
    close: async () => {
      await owner.end();
      await db.drop();
    },
  };
}
