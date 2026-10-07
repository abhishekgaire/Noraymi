import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { withVenue } from "./tenancy.js";
import {
  decideSupportGrant,
  requestSupportGrant,
  resolveSupportGrant,
  supportSnapshot,
  withSupport,
  withSupportAction,
  type SupportContext,
} from "./support-grants.js";
import {
  appPool,
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "./test-helpers.js";

/**
 * M8-10 at the database: a support session is read-only on masked views as
 * app_support (no guests table, no phone numbers, no ID scans), behind the
 * venue wall; a write grant's action spends once; audit rows name the grant.
 */
let db: TestDatabase;
let pool: pg.Pool;
let raw: pg.Client;
let v: TwoVenues;
let staffId = "";
const at = "2026-09-26T02:41:00Z";
const later = "2026-09-26T03:41:00Z"; // 60 minutes on

async function openGrant(venueId: string, scope: "read" | "write", action: string | null) {
  return withVenue(pool, { venueId, userId: staffId }, async (c) => {
    const g = await requestSupportGrant(c, {
      venueId,
      staffId,
      reason: "checking a stuck ticket",
      scope,
      action,
      minutes: 60,
      at,
    });
    const owner = venueId === v.venueA ? v.ownerA : v.ownerB;
    return (await decideSupportGrant(c, {
      venueId,
      id: g.id,
      decision: "approve",
      userId: owner,
      at,
    }))!;
  });
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  pool = appPool(db.url);
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  staffId = (
    await raw.query<{ id: string }>(
      "insert into console_staff (name, email) values ('Sam', 'sam@noraymi.test') returning id",
    )
  ).rows[0]!.id;
  for (const [venueId, name, phone] of [
    [v.venueA, "Marcus T.", "+12125550142"],
    [v.venueB, "Venue B guest", "+12125550199"],
  ] as const)
    await raw.query(
      "insert into guests (venue_id, name, phone_e164, email) values ($1, $2, $3, 'g@example.test')",
      [venueId, name, phone],
    );
});

afterAll(async () => {
  await raw.end();
  await pool.end();
  await db.drop();
});

describe("support sessions (M8-10)", () => {
  it("read through masked views: phone masked, no email, no guests table, no ID scans, no writes", async () => {
    const g = await openGrant(v.venueA, "read", null);
    const ctx: SupportContext = { venueId: v.venueA, staffId, grantId: g.id, at };
    const snap = await withSupport(pool, ctx, (c) => supportSnapshot(c));
    expect(snap.guests).toEqual([
      expect.objectContaining({ name: "Marcus T.", phone_masked: "••• ••• 42", has_email: true }),
    ]);
    expect(JSON.stringify(snap)).not.toContain("5550142");
    await expect(
      withSupport(pool, ctx, (c) => c.query("select phone_e164 from guests")),
    ).rejects.toThrow(/permission denied/);
    await expect(withSupport(pool, ctx, (c) => c.query("select * from id_checks"))).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      withSupport(pool, ctx, (c) =>
        c.query("update support_grants set reason = 'x' where id = $1", [g.id]),
      ),
    ).rejects.toThrow(/read-only transaction/);
    await expect(
      withSupport(pool, ctx, (c) =>
        c.query("insert into guests (venue_id, name) values ($1, 'x')", [v.venueA]),
      ),
    ).rejects.toThrow(/read-only transaction/);
  });

  it("stays behind the venue wall: venue A's grant never shows venue B's rows or opens there", async () => {
    const g = await openGrant(v.venueA, "read", null);
    const rows = await withSupport(pool, { venueId: v.venueA, staffId, grantId: g.id, at }, (c) =>
      c.query<{ name: string }>("select name from support_guests"),
    );
    expect(rows.rows.map((r) => r.name)).toEqual(["Marcus T."]);
    await expect(
      withSupport(pool, { venueId: v.venueB, staffId, grantId: g.id, at }, (c) =>
        c.query("select 1"),
      ),
    ).rejects.toThrow(/isn't open/);
  });

  it("opens only between approval and its end, and only for its staff member", async () => {
    const g = await openGrant(v.venueA, "read", null);
    const resolve = (when: string, who = staffId) =>
      withVenue(pool, { venueId: v.venueA }, (c) =>
        resolveSupportGrant(c, { grantId: g.id, staffId: who, at: when }),
      );
    expect(await resolve(at)).toBe(v.venueA);
    expect(await resolve(later)).toBeNull();
    expect(await resolve(at, v.stranger)).toBeNull();
    await expect(
      withSupport(pool, { venueId: v.venueA, staffId, grantId: g.id, at: later }, (c) =>
        c.query("select 1"),
      ),
    ).rejects.toThrow(/isn't open/);
  });

  it("spends a write grant's action once, and the audit row names our staff member and the grant", async () => {
    const g = await openGrant(v.venueA, "write", "requeue_print");
    const ctx = { venueId: v.venueA, staffId, grantId: g.id, at, action: "requeue_print" };
    await withSupportAction(pool, ctx, async () => undefined);
    await expect(withSupportAction(pool, ctx, async () => undefined)).rejects.toThrow(/isn't open/);
    await expect(
      withSupportAction(pool, { ...ctx, action: "close_night" }, async () => undefined),
    ).rejects.toThrow(/isn't open/);
    const audit = await raw.query<{ actor: string; support_grant_id: string }>(
      "select actor, support_grant_id from audit_log where target = $1 and action = 'support_grants.update' and changed_fields @> '{action_used_at}'",
      [`support_grants/${g.id}`],
    );
    expect(audit.rows).toEqual([{ actor: staffId, support_grant_id: g.id }]);
    const broken = await raw.query<{ id: string | null }>("select verify_audit_chain($1) as id", [
      v.venueA,
    ]);
    expect(broken.rows[0]!.id).toBeNull();
  });
});
