import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { withVenue } from "./tenancy.js";
import {
  decideEmergencyAction,
  emergencyAction,
  emergencyActions,
  requestEmergencyAction,
} from "./emergency-actions.js";
import {
  appPool,
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "./test-helpers.js";

/**
 * M8-11 at the database: emergency_actions sits behind the venue wall (row-
 * level security forced), the one who asked can never be the one who decides,
 * a request is time-boxed to at most 60 minutes, only the four listed actions
 * exist, and audit rows written with the emergency context name the request
 * and the second approver, with the chain still verifying.
 */
let db: TestDatabase;
let pool: pg.Pool;
let raw: pg.Client;
let v: TwoVenues;
let ana = "";
let ben = "";
const at = "2026-09-26T02:41:00Z";

const ask = (venueId: string, staffId: string, action = "requeue_print") =>
  withVenue(pool, { venueId, userId: staffId }, (c) =>
    requestEmergencyAction(c, {
      venueId,
      staffId,
      action,
      target: "00000000-0000-4000-8000-000000000001",
      fixes: [],
      reason: "printer jammed",
      at,
      minutes: 15,
    }),
  );

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  pool = appPool(db.url);
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  [ana, ben] = (
    await raw.query<{ id: string }>(
      "insert into console_staff (name, email) values ('Ana', 'ana@noraymi.test'), ('Ben', 'ben@noraymi.test') returning id",
    )
  ).rows.map((r) => r.id) as [string, string];
});

afterAll(async () => {
  await pool?.end();
  await raw?.end();
  await db?.drop();
});

describe("emergency_actions (M8-11)", () => {
  it("is forced behind the venue wall", async () => {
    const forced = await raw.query<{ relforcerowsecurity: boolean }>(
      "select relforcerowsecurity from pg_class where relname = 'emergency_actions'",
    );
    expect(forced.rows[0]!.relforcerowsecurity).toBe(true);
    const b = await ask(v.venueB, ana);
    // Venue A sees none of venue B's rows, by id or in its list, and can't decide them.
    await withVenue(pool, { venueId: v.venueA, userId: ben }, async (c) => {
      expect(await emergencyAction(c, v.venueB, b.id)).toBeNull();
      expect(await emergencyActions(c, v.venueB)).toEqual([]);
      expect(
        await decideEmergencyAction(c, {
          venueId: v.venueB,
          id: b.id,
          decision: "approve",
          staffId: ben,
          at,
        }),
      ).toBeNull();
      // Nor write one for venue B.
      await expect(
        c.query(
          `insert into emergency_actions (venue_id, action, target, reason, requested_by, requested_at, expires_at)
           values ($1, 'requeue_print', 'x', 'nope', $2, now(), now() + interval '5 minutes')`,
          [v.venueB, ben],
        ),
      ).rejects.toThrow(/row-level security/);
    });
    const still = await raw.query<{ status: string }>(
      "select status from emergency_actions where id = $1",
      [b.id],
    );
    expect(still.rows[0]!.status).toBe("requested");
  });

  it("never lets the one who asked decide, and keeps only the four actions and 60 minutes", async () => {
    const e = await ask(v.venueA, ana);
    const own = await withVenue(pool, { venueId: v.venueA, userId: ana }, (c) =>
      decideEmergencyAction(c, {
        venueId: v.venueA,
        id: e.id,
        decision: "approve",
        staffId: ana,
        at,
      }),
    );
    expect(own).toBeNull();
    await expect(
      raw.query("update emergency_actions set status = 'declined', decided_by = $2 where id = $1", [
        e.id,
        ana,
      ]),
    ).rejects.toThrow(/check/);
    await expect(ask(v.venueA, ana, "void_check")).rejects.toThrow(/check/);
    await expect(
      raw.query(
        `insert into emergency_actions (venue_id, action, target, reason, requested_by, requested_at, expires_at)
         values ($1, 'requeue_print', 'x', 'too long', $2, now(), now() + interval '61 minutes')`,
        [v.venueA, ana],
      ),
    ).rejects.toThrow(/check/);
    // Past its time box nobody can approve it.
    const late = await withVenue(pool, { venueId: v.venueA, userId: ben }, (c) =>
      decideEmergencyAction(c, {
        venueId: v.venueA,
        id: e.id,
        decision: "approve",
        staffId: ben,
        at: "2026-09-26T02:56:00Z",
      }),
    );
    expect(late).toBeNull();
    const ok = await withVenue(pool, { venueId: v.venueA, userId: ben }, (c) =>
      decideEmergencyAction(c, {
        venueId: v.venueA,
        id: e.id,
        decision: "approve",
        staffId: ben,
        at,
      }),
    );
    expect(ok?.status).toBe("approved");
    expect(ok?.decided_by_name).toBe("Ben");
  });

  it("names the request and the second approver in every audit row, and the chain verifies", async () => {
    const e = await ask(v.venueA, ana);
    await withVenue(
      pool,
      { venueId: v.venueA, userId: ana, emergency: { actionId: e.id, approverId: ben } },
      (c) => c.query("update emergency_actions set result = '{\"n\": 1}' where id = $1", [e.id]),
    );
    const rows = await raw.query<{ actor: string; approver: string; emergency_action_id: string }>(
      "select actor, approver, emergency_action_id from audit_log where venue_id = $1 and emergency_action_id is not null",
      [v.venueA],
    );
    expect(rows.rows).toEqual([{ actor: ana, approver: ben, emergency_action_id: e.id }]);
    const chain = await raw.query<{ id: string | null }>("select verify_audit_chain($1) as id", [
      v.venueA,
    ]);
    expect(chain.rows[0]!.id).toBeNull();
  });
});
