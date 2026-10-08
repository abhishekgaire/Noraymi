import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadDemoSeed, withVenue } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { trainingEvidence, trainingReport } from "./training-check.js";

/**
 * M9-10: before the first live night nobody is in training mode, and no device is either,
 * except a new hire's phone named on purpose.
 */
let db: TestDatabase;
let owner: pg.Client;
let pool: pg.Pool;
let venueId: string;

const check = (allow: string[] = []) =>
  withVenue(pool, { venueId, requestId: "test" }, (c) => trainingEvidence(c, venueId, allow));

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  owner = new pg.Client({ connectionString: db.url });
  await owner.connect();
  pool = new pg.Pool({ connectionString: db.url, max: 2 });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
});

afterAll(async () => {
  await pool.end();
  await owner.end();
  await db.drop();
});

describe("the training check (M9-10)", () => {
  it("passes on the demo seed, where nobody is in training", async () => {
    const e = await check();
    expect(e.ok).toBe(true);
    expect(trainingReport("west4karaoke", e)).toContain(
      "Nobody and no device is in training mode.",
    );
  });

  it("names a person and a device left in training, and lets a new hire's phone through on purpose", async () => {
    const person = (
      await owner.query<{ name: string }>(
        `update memberships m set training = true from users u
          where u.id = m.user_id and m.venue_id = $1 and m.role <> 'owner'
          and m.id = (select id from memberships where venue_id = $1 and role <> 'owner' order by id limit 1)
          returning u.name`,
        [venueId],
      )
    ).rows[0]!.name;
    const [a, b] = (
      await owner.query<{ name: string }>(
        `update devices set training = true where id in (
           select id from devices where venue_id = $1 and revoked_at is null and disabled_at is null
           order by name limit 2) returning name`,
        [venueId],
      )
    ).rows.map((r) => r.name);
    const e = await check([b!]);
    expect(e.ok).toBe(false);
    expect(e.people.map((p) => p.name)).toEqual([person]);
    expect(e.devices.map((d) => d.name)).toEqual([a]);
    expect(e.allowed).toEqual([b]);
    const report = trainingReport("west4karaoke", e);
    expect(report).toContain(`| person | ${person} |`);
    expect(report).toContain(`In device training on purpose: ${b}.`);
    await owner.query("update memberships set training = false where venue_id = $1", [venueId]);
    await owner.query("update devices set training = false where venue_id = $1 and name = $2", [
      venueId,
      a,
    ]);
    expect((await check([b!])).ok).toBe(true);
  });
});
