import { randomBytes } from "node:crypto";
import pg from "pg";
import { createDatabase, dropDatabase } from "./admin.js";
import { databaseName, databaseUrl, migrationsDir, withDatabase } from "./config.js";
import { migrate } from "./migrate.js";

export interface TestDatabase {
  readonly url: string;
  drop(): Promise<void>;
}

/**
 * A throwaway database on the local server, named west4_test_xxxx, so tests
 * never touch the development database and can run side by side.
 */
export async function createTestDatabase(
  options: { migrate?: boolean } = {},
): Promise<TestDatabase> {
  const name = `west4_test_${randomBytes(4).toString("hex")}`;
  const url = withDatabase(databaseUrl(), name);
  await createDatabase(url);
  if (options.migrate) await migrate({ databaseUrl: url, dir: migrationsDir });
  return {
    url,
    drop: () => dropDatabase(url),
  };
}

/**
 * A whole-database copy of `source`, as a backup restored to a scratch
 * database would be (M8-14). Every connection to `source` must be closed first.
 */
export async function copyTestDatabase(source: TestDatabase): Promise<TestDatabase> {
  const name = `west4_test_${randomBytes(4).toString("hex")}`;
  const url = withDatabase(databaseUrl(), name);
  // Pools end their clients asynchronously: give them a moment before the copy.
  for (let i = 0; ; i += 1) {
    try {
      await createDatabase(url, databaseName(source.url));
      break;
    } catch (e) {
      if (i >= 80 || !String((e as Error).message).includes("being accessed")) throw e;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  return { url, drop: () => dropDatabase(url) };
}

/**
 * A pool that behaves like the API: every connection switches to app_rw, so
 * row-level security is forced and the grants apply. The owner connects and
 * "set role"s, which needs no app_rw password in tests.
 */
export function appPool(url: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: url, max: 4, application_name: "west4-test" });
  pool.on("connect", (client) => {
    client.query("set role app_rw").catch(() => {});
  });
  return pool;
}

export interface TwoVenues {
  readonly orgId: string;
  readonly venueA: string;
  readonly venueB: string;
  /** Active owner of venue A only. */
  readonly ownerA: string;
  /** Bartender at venue A. */
  readonly bartenderA: string;
  /** Active owner of venue B only. */
  readonly ownerB: string;
  /** Active owner of both venues (one org). */
  readonly ownerBoth: string;
  readonly membershipA: string;
  readonly membershipB: string;
  /** Someone with no membership anywhere. */
  readonly stranger: string;
}

/** Venue A and venue B in one organization, with owners and staff, inserted as the owner. */
export async function seedTwoVenues(url: string): Promise<TwoVenues> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const org = await one(
      client,
      "insert into organizations (legal_name) values ('Test Org LLC') returning id",
    );
    const venueA = await one(
      client,
      "insert into venues (org_id, name, slug) values ($1, 'Venue A', $2) returning id",
      [org, `venue-a-${randomBytes(2).toString("hex")}`],
    );
    const venueB = await one(
      client,
      "insert into venues (org_id, name, slug) values ($1, 'Venue B', $2) returning id",
      [org, `venue-b-${randomBytes(2).toString("hex")}`],
    );
    const user = (name: string) =>
      one(client, "insert into users (name) values ($1) returning id", [name]);
    const ownerA = await user("Owner A");
    const bartenderA = await user("Bartender A");
    const ownerB = await user("Owner B");
    const ownerBoth = await user("Owner Both");
    const stranger = await user("Stranger");
    const member = (venue: string, u: string, role: string) =>
      one(
        client,
        "insert into memberships (venue_id, user_id, role, status) values ($1, $2, $3, 'active') returning id",
        [venue, u, role],
      );
    const membershipA = await member(venueA, ownerA, "owner");
    await member(venueA, bartenderA, "bartender");
    const membershipB = await member(venueB, ownerB, "owner");
    await member(venueA, ownerBoth, "owner");
    await member(venueB, ownerBoth, "owner");
    return {
      orgId: org,
      venueA,
      venueB,
      ownerA,
      bartenderA,
      ownerB,
      ownerBoth,
      membershipA,
      membershipB,
      stranger,
    };
  } finally {
    await client.end();
  }
}

async function one(client: pg.Client, sql: string, params: unknown[] = []): Promise<string> {
  const result = await client.query<{ id: string }>(sql, params);
  const row = result.rows[0];
  if (!row) throw new Error(`no row from ${sql}`);
  return row.id;
}
