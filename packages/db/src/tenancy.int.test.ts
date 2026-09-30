import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withOrgScope, withVenue } from "./tenancy.js";
import {
  appPool,
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "./test-helpers.js";

let db: TestDatabase;
let pool: pg.Pool;
let v: TwoVenues;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  pool = appPool(db.url);
});

afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe("the venue wall", () => {
  it("with app.venue_id unset, select * from memberships raises instead of returning rows", async () => {
    const client = await pool.connect();
    try {
      await expect(client.query("select * from memberships")).rejects.toThrow(
        /app.venue_id is not set/,
      );
    } finally {
      client.release();
    }
  });

  it("as venue A, venue B's membership is invisible by id, and inserting a venue B row fails the policy", async () => {
    const rows = await withVenue(pool, { venueId: v.venueA }, (c) =>
      c.query("select id from memberships where id = $1", [v.membershipB]),
    );
    expect(rows.rowCount).toBe(0);

    const own = await withVenue(pool, { venueId: v.venueA }, (c) =>
      c.query("select id from memberships where id = $1", [v.membershipA]),
    );
    expect(own.rowCount).toBe(1);

    await expect(
      withVenue(pool, { venueId: v.venueA }, (c) =>
        c.query("insert into memberships (venue_id, user_id, role) values ($1, $2, 'staff')", [
          v.venueB,
          v.stranger,
        ]),
      ),
    ).rejects.toThrow(/row-level security policy/);
  });

  it("app_rw has no BYPASSRLS, can't delete, and the linter passes on every table", async () => {
    const role = await pool.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      "select rolbypassrls, rolsuper from pg_roles where rolname = 'app_rw'",
    );
    expect(role.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    await expect(
      withVenue(pool, { venueId: v.venueA }, (c) =>
        c.query("delete from memberships where id = $1", [v.membershipA]),
      ),
    ).rejects.toThrow(/permission denied/);
    // Every table with venue_id has RLS enabled and forced.
    const unforced = await pool.query<{ relname: string }>(`
      select c.relname from pg_class c
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'venue_id' and not a.attisdropped
      where c.relkind = 'r' and c.relnamespace = 'public'::regnamespace
        and not (c.relrowsecurity and c.relforcerowsecurity)`);
    expect(unforced.rows).toEqual([]);
  });

  it("org_read shows venues only in a read-only org-scope transaction, only where the user is an active owner", async () => {
    const list = (userId: string) =>
      withOrgScope(pool, { userId }, async (c) =>
        (await c.query<{ name: string }>("select name from venues order by name")).rows.map(
          (r) => r.name,
        ),
      );
    expect(await list(v.ownerBoth)).toEqual(["Venue A", "Venue B"]);
    expect(await list(v.ownerA)).toEqual(["Venue A"]);
    expect(await list(v.bartenderA)).toEqual([]);
    expect(await list(v.stranger)).toEqual([]);

    // The same settings without "read only" are not org scope: with no venue set, the query errors.
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.scope', 'org', true)");
      await client.query("select set_config('app.user_id', $1, true)", [v.ownerBoth]);
      await expect(client.query("select name from venues")).rejects.toThrow(
        /app.venue_id is not set/,
      );
    } finally {
      await client.query("rollback").catch(() => {});
      client.release();
    }

    // A deactivated owner loses the org view.
    const admin = new pg.Client({ connectionString: db.url });
    await admin.connect();
    await admin.query(
      "update memberships set status = 'deactivated' where user_id = $1 and venue_id = $2",
      [v.ownerBoth, v.venueB],
    );
    await admin.end();
    expect(await list(v.ownerBoth)).toEqual(["Venue A"]);
  });

  it("a user sees their own row and the members of the current venue, and no one else", async () => {
    const names = (venueId: string, userId: string) =>
      withVenue(pool, { venueId, userId }, async (c) =>
        (await c.query<{ name: string }>("select name from users order by name")).rows.map(
          (r) => r.name,
        ),
      );
    expect(await names(v.venueA, v.bartenderA)).toEqual(["Bartender A", "Owner A", "Owner Both"]);
    // Owner B at venue B sees venue B's people plus themselves; the stranger sees only themselves.
    expect(await names(v.venueB, v.ownerB)).toEqual(["Owner B", "Owner Both"]);
    expect(await names(v.venueA, v.stranger)).toEqual([
      "Bartender A",
      "Owner A",
      "Owner Both",
      "Stranger",
    ]);
  });

  it("organizations shows only the current venue's, and a venue sees only itself", async () => {
    const orgs = await withVenue(pool, { venueId: v.venueA }, (c) =>
      c.query("select id from organizations"),
    );
    expect(orgs.rows).toEqual([{ id: v.orgId }]);
    const venues = await withVenue(pool, { venueId: v.venueB }, (c) =>
      c.query<{ name: string }>("select name from venues"),
    );
    expect(venues.rows).toEqual([{ name: "Venue B" }]);
  });

  it("the settings end with the transaction, so the next request starts walled", async () => {
    await withVenue(pool, { venueId: v.venueA }, (c) =>
      c.query("select count(*) from memberships"),
    );
    const client = await pool.connect();
    try {
      await expect(client.query("select count(*) from memberships")).rejects.toThrow(
        /app.venue_id is not set/,
      );
    } finally {
      client.release();
    }
  });
});
