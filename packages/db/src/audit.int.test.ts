import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withVenue } from "./tenancy.js";
import {
  appPool,
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "./test-helpers.js";

let db: TestDatabase;
let pool: pg.Pool;
let owner: pg.Client;
let v: TwoVenues;

interface AuditRow {
  id: string;
  venue_id: string;
  actor: string | null;
  action: string;
  target: string;
  changed_fields: string[];
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  request_id: string | null;
  prev_hash: string | null;
  hash: string;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  pool = appPool(db.url);
  owner = new pg.Client({ connectionString: db.url });
  await owner.connect();
});

afterAll(async () => {
  await owner.end();
  await pool.end();
  await db.drop();
});

describe("the audit log", () => {
  it("changing a role writes one row with the old and new role, the actor and the request id", async () => {
    const before = await owner.query(
      "select count(*)::int as n from audit_log where venue_id = $1",
      [v.venueA],
    );
    await withVenue(pool, { venueId: v.venueA, userId: v.ownerA, requestId: "req-42" }, (c) =>
      c.query("update memberships set role = 'front_desk' where user_id = $1", [v.bartenderA]),
    );
    const rows = await owner.query<AuditRow>(
      "select * from audit_log where venue_id = $1 order by id desc limit 1",
      [v.venueA],
    );
    const after = await owner.query(
      "select count(*)::int as n from audit_log where venue_id = $1",
      [v.venueA],
    );
    expect(after.rows[0].n - before.rows[0].n).toBe(1);
    const row = rows.rows[0]!;
    expect(row.action).toBe("memberships.update");
    expect(row.actor).toBe(v.ownerA);
    expect(row.request_id).toBe("req-42");
    expect(row.changed_fields).toEqual(["role"]);
    expect(row.old_values).toEqual({ role: "bartender" });
    expect(row.new_values).toEqual({ role: "front_desk" });
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a column on the redaction list shows as changed, with no old or new value", async () => {
    await withVenue(pool, { venueId: v.venueA, userId: v.ownerA }, (c) =>
      c.query("update users set email = 'diego@example.com', name = 'Diego R.' where id = $1", [
        v.bartenderA,
      ]),
    );
    const row = (
      await owner.query<AuditRow>(
        "select * from audit_log where target = $1 order by id desc limit 1",
        [`users/${v.bartenderA}`],
      )
    ).rows[0]!;
    expect(row.changed_fields).toEqual(["email", "name"]);
    expect(row.old_values).toEqual({ name: "Bartender A" });
    expect(row.new_values).toEqual({ name: "Diego R." });
    expect(JSON.stringify(row)).not.toContain("diego@example.com");
  });

  it("the chain links each row to the one before, per venue, and verifies clean", async () => {
    const rows = (
      await owner.query<AuditRow>("select * from audit_log where venue_id = $1 order by id", [
        v.venueA,
      ])
    ).rows;
    expect(rows.length).toBeGreaterThan(2);
    expect(rows[0]?.prev_hash).toBeNull();
    for (let i = 1; i < rows.length; i += 1) expect(rows[i]?.prev_hash).toBe(rows[i - 1]?.hash);
    const clean = await pool.query<{ broken: string | null }>(
      "select verify_audit_chain($1) as broken",
      [v.venueA],
    );
    expect(clean.rows[0]?.broken).toBeNull();
  });

  it("editing an audit row's new_values as the database owner makes verify_audit_chain report that row", async () => {
    const target = (
      await owner.query<AuditRow>(
        "select id from audit_log where venue_id = $1 order by id limit 1 offset 1",
        [v.venueA],
      )
    ).rows[0]!;
    await owner.query(
      "update audit_log set new_values = coalesce(new_values, '{}') || '{\"role\": \"tampered\"}' where id = $1",
      [target.id],
    );
    const result = await pool.query<{ broken: string | null }>(
      "select verify_audit_chain($1) as broken",
      [v.venueA],
    );
    expect(result.rows[0]?.broken).toBe(target.id);
    // Venue B's chain is untouched.
    const other = await pool.query<{ broken: string | null }>(
      "select verify_audit_chain($1) as broken",
      [v.venueB],
    );
    expect(other.rows[0]?.broken).toBeNull();
  });

  it("app_rw can't insert, update or delete audit_log, and can only read its own venue's rows", async () => {
    await expect(
      withVenue(pool, { venueId: v.venueA }, (c) =>
        c.query("update audit_log set request_id = 'x' where venue_id = $1", [v.venueA]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withVenue(pool, { venueId: v.venueA }, (c) =>
        c.query("delete from audit_log where venue_id = $1", [v.venueA]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withVenue(pool, { venueId: v.venueA }, (c) =>
        c.query(
          "insert into audit_log (venue_id, action, target, changed_fields, at, hash) values ($1, 'x', 'x', '{}', now(), 'x')",
          [v.venueA],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    const seen = await withVenue(pool, { venueId: v.venueB }, (c) =>
      c.query<{ venue_id: string }>("select distinct venue_id from audit_log"),
    );
    expect(seen.rows).toEqual([{ venue_id: v.venueB }]);
  });

  it("truncate on any table raises the alert, and DDL outside a migration does too", async () => {
    await owner.query("create table scratch_for_alert (id int)");
    await owner.query("truncate scratch_for_alert");
    const alerts = await owner.query<{ kind: string; detail: string }>(
      "select kind, detail from security_alerts order by id",
    );
    expect(
      alerts.rows.some((a) => a.kind === "ddl" && a.detail.includes("scratch_for_alert")),
    ).toBe(true);
    expect(
      alerts.rows.some((a) => a.kind === "truncate" && a.detail.startsWith("scratch_for_alert")),
    ).toBe(true);
    // The migrations themselves raised no DDL alert.
    expect(alerts.rows.filter((a) => a.kind === "ddl" && a.detail.includes("audit_log"))).toEqual(
      [],
    );
  });

  it("audit_head_before returns the business date's last hash for the export", async () => {
    const head = await withVenue(pool, { venueId: v.venueA }, (c) =>
      c.query<{ id: string; hash: string }>(
        "select id, hash from audit_head_before($1, now() + interval '1 hour')",
        [v.venueA],
      ),
    );
    const last = await owner.query<AuditRow>(
      "select id, hash from audit_log where venue_id = $1 order by id desc limit 1",
      [v.venueA],
    );
    expect(head.rows[0]).toEqual({ id: last.rows[0]?.id, hash: last.rows[0]?.hash });
  });
});
