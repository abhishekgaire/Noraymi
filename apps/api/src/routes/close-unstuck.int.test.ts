import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  LOCAL_DEV_AUTH_KEY as KEY,
  generateSigningKey,
  loadDemoSeed,
  publishRulePack,
} from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, Temporal, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { zReportAtCloseOut } from "../nights/z-at-close.js";
import { sweepClearOut } from "../rooms/clear-out.js";
import type { Principal, SessionKind } from "../http/principal.js";

/**
 * Close the night without getting stuck (U-15; D133), with the API connected as app_rw (row-level
 * security forced), as it runs: Diego still on the clock at 4 AM is clocked out from the close by
 * Andy with a reason and his PIN, audited as a punch edit on Staff actions; the waitlist clears in one
 * call with no offer passed on; the rooms still cleaning are marked clean; and the close prints the
 * Z report and queues it to the owner, once, unless the venue turned it off.
 */
let db: TestDatabase;
let owner: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
let memberships: Record<string, string>;
const clock = new FrozenClock(SEED_NOW);
let n = 0;

type Role = "owner" | "manager" | "bartender" | "front_desk";
let who: { slug: string; role: Role; session: SessionKind } = {
  slug: "andy",
  role: "manager",
  session: "pin",
};
const as = (slug: string, role: Role, session: SessionKind) => {
  who = { slug, role, session };
};
const post = (path: string, payload?: unknown) =>
  api.inject({
    method: "POST",
    url: `/v1/venues/${venueId}${path}`,
    headers: { "idempotency-key": `u15-${++n}` },
    ...(payload ? { payload } : {}),
  });
const get = (path: string) => api.inject({ method: "GET", url: `/v1/venues/${venueId}${path}` });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  const key = generateSigningKey().privateKeyPem;
  for (const pack of [newYorkCounty, newYorkCountyTaxed])
    await publishRulePack(owner, {
      pack,
      effectiveOn: "2026-09-01",
      approvedBy: ["A", "B"],
      privateKeyPem: key,
    });
  ids = Object.fromEntries(
    (
      await owner.query<{ slug: string; id: string }>("select slug, row_id as id from seed_ids")
    ).rows.map((r) => [r.slug, r.id]),
  );
  memberships = Object.fromEntries(
    (
      await owner.query<{ user_id: string; id: string }>(
        "select user_id, id from memberships where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.user_id, r.id]),
  );
  api = buildApp({
    config: loadConfig({
      WEST4_ENV: "local",
      DATABASE_URL: db.url,
      APP_DATABASE_URL: db.url.replace("//west4:west4@", "//app_rw:app_rw@"),
      AUTH_SECRET_KEY: KEY,
    }),
    clock,
    moduleCacheMs: 0,
    authenticators: [
      async (request: FastifyRequest): Promise<Principal> => {
        const userId = ids[who.slug]!;
        const deviceId = ids["dev_bar_computer"]!;
        Object.assign(request, {
          session: { assurance: who.session, membershipId: memberships[userId], deviceId },
          signedDevice: { deviceId, venueId, kind: "bar_computer" },
        });
        return {
          kind: "user",
          userId,
          session: who.session,
          memberships: [{ venueId, membershipId: memberships[userId]!, role: who.role }],
        };
      },
    ],
  });
  await api.ready();
});

afterAll(async () => {
  await api.close();
  await owner.end();
  await db.drop();
});

const FRI = "2026-09-25";
interface Check {
  id: string;
  count: number;
  blocking: boolean;
  names: string[];
  items?: { id: string; name: string; since?: string }[];
}
const checks = async () => {
  const r = await get(`/nights/${FRI}`);
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as { checks: Check[] }).checks;
};
const check = (all: Check[], id: string) => all.find((c) => c.id === id)!;
const diego = () => memberships[ids["diego"]!]!;
const maya = () => memberships[ids["maya"]!]!;

describe("Close the night without getting stuck (U-15)", () => {
  it("lists who's still on with their membership and last punch, and the rooms still cleaning", async () => {
    clock.set(Temporal.Instant.from("2026-09-26T04:12:00-04:00"));
    const all = await checks();
    const on = check(all, "on_the_clock");
    expect(on.names).toEqual(["Maya S.", "Diego R."]);
    expect(on.items!.map((i) => i.id)).toEqual([maya(), diego()]);
    for (const i of on.items!) expect(Temporal.Instant.from(i.since!)).toBeTruthy();
    const cleaning = check(all, "cleaning");
    expect(cleaning.items!.map((i) => i.name)).toEqual(cleaning.names);
  });

  it("refuses a bartender, a missing reason, a time outside the shift, one's own shift and a PIN session without the PIN", async () => {
    as("maya", "bartender", "pin");
    expect((await post(`/team/${diego()}/clock-out`, { reason: "Forgot" })).statusCode).toBe(403);
    as("andy", "manager", "pin");
    const noReason = await post(`/team/${diego()}/clock-out`, { pin: "730915" });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().error.details.reason).toBe("reason");
    const future = await post(`/team/${diego()}/clock-out`, {
      reason: "Forgot",
      at: "2026-09-26T04:30:00-04:00",
      pin: "730915",
    });
    expect(future.statusCode).toBe(400);
    expect(future.json().error.details.reason).toBe("at");
    const early = await post(`/team/${diego()}/clock-out`, {
      reason: "Forgot",
      at: "2026-09-25T12:00:00-04:00",
      pin: "730915",
    });
    expect(early.statusCode).toBe(400);
    const own = await post(`/team/${memberships[ids["andy"]!]}/clock-out`, {
      reason: "Me",
      pin: "730915",
    });
    expect(own.statusCode).toBe(403);
    const noPin = await post(`/team/${diego()}/clock-out`, { reason: "Forgot" });
    expect(noPin.statusCode).toBe(400);
    expect(noPin.json().error.details.reason).toBe("pin");
    const wrong = await post(`/team/${diego()}/clock-out`, { reason: "Forgot", pin: "000000" });
    expect(wrong.statusCode).toBe(401);
    // Nothing changed: Diego is still on.
    expect(check(await checks(), "on_the_clock").names).toContain("Diego R.");
  });

  it("clocks Diego out at the time Andy picks, with his PIN, audited as a punch edit on Staff actions", async () => {
    as("andy", "manager", "pin");
    const r = await post(`/team/${diego()}/clock-out`, {
      reason: "Forgot to clock out",
      at: "2026-09-26T04:00:00-04:00",
      pin: "730915",
    });
    expect(r.statusCode, r.body).toBe(200);
    const shift = r.json().shift as { punches: { kind: string; at: string }[] };
    expect(shift.punches.at(-1)!.kind).toBe("clock_out");
    expect(Temporal.Instant.from(shift.punches.at(-1)!.at).toString()).toBe("2026-09-26T08:00:00Z");
    const punch = (
      await owner.query<{ edited_by: string; reason: string }>(
        `select edited_by, reason from time_punches where venue_id = $1 and membership_id = $2
          and kind = 'clock_out' order by at desc limit 1`,
        [venueId, diego()],
      )
    ).rows[0]!;
    expect(punch).toEqual({ edited_by: ids["andy"], reason: "Forgot to clock out" });
    expect(check(await checks(), "on_the_clock").names).toEqual(["Maya S."]);
    // Clocked out already: a second try is refused.
    expect(
      (await post(`/team/${diego()}/clock-out`, { reason: "Again", pin: "730915" })).statusCode,
    ).toBe(409);
    // Staff actions (P-09) counts it as Andy's punch edit.
    as("andy", "manager", "passkey");
    const actions = await get(`/reports/staff-actions?date=${FRI}`);
    expect(actions.statusCode, actions.body).toBe(200);
    expect(JSON.stringify(actions.json())).toContain("punch_edit");
    expect(JSON.stringify(actions.json())).toContain("Forgot to clock out");
  });

  it("clears the waitlist in one call with no offer passed on, and marks the cleaning rooms clean", async () => {
    as("andy", "manager", "pin");
    const textsBefore = (
      await owner.query("select 1 from jobs where venue_id = $1 and kind like 'text%'", [venueId])
    ).rowCount;
    const r = await post("/waitlist/clear");
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().cleared).toBe(3);
    expect(
      (
        await owner.query(
          "select 1 from waitlist_entries where venue_id = $1 and status in ('waiting', 'offered')",
          [venueId],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (await owner.query("select 1 from jobs where venue_id = $1 and kind like 'text%'", [venueId]))
        .rowCount,
    ).toBe(textsBefore);
    for (const room of check(await checks(), "cleaning").items!)
      expect((await post(`/rooms/${room.id}/clean`, {})).statusCode).toBe(200);
    const after = await checks();
    expect(check(after, "waitlist").blocking).toBe(false);
    expect(check(after, "cleaning").blocking).toBe(false);
  });

  it("closes in a PIN session with the PIN, prints the Z report at the bar and queues it to the owner once", async () => {
    as("andy", "manager", "pin");
    // The rest of the fixes, as the screens would make them.
    await owner.query(
      "update room_sessions set ended_at = now() where venue_id = $1 and ended_at is null",
      [venueId],
    );
    await owner.query(
      "update tabs set state = 'captured' where venue_id = $1 and state in ('open', 'tipping')",
      [venueId],
    );
    const mayaOut = await post(`/team/${maya()}/clock-out`, {
      reason: "Forgot to clock out",
      pin: "730915",
    });
    expect(mayaOut.statusCode, mayaOut.body).toBe(200);
    await owner.query(
      "update orders set status = 'cancelled', cancel_reason = 'staff' where venue_id = $1 and status in ('ringing', 'held')",
      [venueId],
    );
    await owner.query(
      "update approvals set status = 'declined' where venue_id = $1 and status = 'pending'",
      [venueId],
    );
    await owner.query("update order_drafts set lines = '[]' where venue_id = $1", [venueId]);
    await owner.query(
      "update drawer_sessions set state = 'counted', counted_cents = opening_cents, expected_cents = opening_cents, over_short_cents = 0 where venue_id = $1 and state = 'open'",
      [venueId],
    );
    clock.set(Temporal.Instant.from("2026-09-26T04:31:00-04:00"));
    await sweepClearOut(owner, clock.now());
    expect((await post(`/nights/${FRI}/clear-out`, {})).statusCode).toBe(200);
    clock.set(Temporal.Instant.from("2026-09-26T04:48:00-04:00"));
    const noPin = await post(`/nights/${FRI}/close`, {});
    expect(noPin.statusCode).toBe(400);
    expect(noPin.json().error.details.reason).toBe("pin");
    const r = await post(`/nights/${FRI}/close`, { pin: "730915" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ z_number: 1, z_report: { printed_at: "bar" } });
    const owners = (
      await owner.query<{ email: string }>(
        `select u.email from memberships m join users u on u.id = m.user_id
          where m.venue_id = $1 and m.role = 'owner' and m.status = 'active' and u.email is not null`,
        [venueId],
      )
    ).rows.map((o) => o.email);
    expect(owners.length).toBeGreaterThan(0);
    expect([...r.json().z_report.emailed_to].sort()).toEqual([...owners].sort());
    const prints = await owner.query<{ station: string; payload: { lines: string[] } }>(
      "select station, payload from print_jobs where venue_id = $1 and kind = 'z_report'",
      [venueId],
    );
    expect(prints.rows).toHaveLength(1);
    expect(prints.rows[0]!.station).toBe("bar");
    expect(prints.rows[0]!.payload.lines[0]).toBe("Z REPORT 1");
    const emails = await owner.query<{ payload: { template: string; data: { zNumber: number } } }>(
      "select payload from jobs where venue_id = $1 and kind = 'email.send' and payload->>'template' = 'z_report'",
      [venueId],
    );
    expect(emails.rows).toHaveLength(owners.length);
    expect(emails.rows[0]!.payload.data.zNumber).toBe(1);
    // The same night again queues no second email: the job is keyed on the night and the address.
    const c = await owner.connect();
    try {
      await c.query("begin");
      await zReportAtCloseOut(c, {
        venueId,
        date: FRI,
        now: clock.now(),
        deviceId: null,
        email: { allowList: null },
      });
      expect(
        (
          await c.query(
            "select 1 from jobs where venue_id = $1 and kind = 'email.send' and payload->>'template' = 'z_report'",
            [venueId],
          )
        ).rowCount,
      ).toBe(owners.length);
    } finally {
      await c.query("rollback");
      c.release();
    }
  });

  it("with the setting off, the close neither prints nor emails the Z report", async () => {
    const c = await owner.connect();
    try {
      await c.query("begin");
      await c.query(
        `update venue_settings set value = value || '{"zReportAtClose": false}'::jsonb
          where venue_id = $1 and key = 'pos'`,
        [venueId],
      );
      const out = await zReportAtCloseOut(c, {
        venueId,
        date: FRI,
        now: clock.now(),
        deviceId: null,
        email: { allowList: null },
      });
      expect(out).toBeNull();
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});
