import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  LOCAL_DEV_AUTH_KEY as KEY,
  generateSigningKey,
  loadDemoSeed,
  publishRulePack,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, Temporal, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { sweepClearOut } from "../rooms/clear-out.js";
import type { Principal, SessionKind } from "../http/principal.js";

/**
 * Close the night (M7-12; spec 08 · Night close): the checks before closing,
 * each named while it's open and blocking the close; slips and failed
 * captures shown but not blocking; the clear-out check; the close itself
 * (Z 1, the pool closed, the manager clocked out, 86s and Closed tonight
 * cleared); and two managers closing at once, one winning.
 */
let db: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
const clock = new FrozenClock(SEED_NOW);
let n = 0;

type Role = "owner" | "manager" | "bartender" | "front_desk";
interface Who {
  slug: string;
  role: Role;
  session: SessionKind;
  device: string;
  deviceKind: "bar_computer" | "front_desk" | "staff_phone";
}
let who: Who;
const as = (slug: string, role: Role, session: SessionKind, device: string) => {
  who = {
    slug,
    role,
    session,
    device,
    deviceKind: device.startsWith("dev_phone")
      ? "staff_phone"
      : device === "dev_bar_computer"
        ? "bar_computer"
        : "front_desk",
  };
};
const post = (path: string, payload?: unknown) =>
  api.inject({
    method: "POST",
    url: `/v1/venues/${venueId}${path}`,
    headers: { "idempotency-key": `drawer-${++n}` },
    ...(payload ? { payload } : {}),
  });
const get = (path: string) => api.inject({ method: "GET", url: `/v1/venues/${venueId}${path}` });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  app = appPool(db.url);
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
  const memberships = Object.fromEntries(
    (
      await owner.query<{ user_id: string; id: string }>(
        "select user_id, id from memberships where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.user_id, r.id]),
  );
  as("andy", "manager", "passkey", "dev_phone_andy");
  api = buildApp({
    config: loadConfig({
      WEST4_ENV: "local",
      DATABASE_URL: db.url,
      APP_DATABASE_URL: db.url,
      AUTH_SECRET_KEY: KEY,
    }),
    clock,
    moduleCacheMs: 0,
    authenticators: [
      async (request: FastifyRequest): Promise<Principal> => {
        const userId = ids[who.slug]!;
        const deviceId = ids[who.device]!;
        Object.assign(request, {
          session: {
            assurance: who.session,
            membershipId: memberships[userId],
            deviceId,
          },
          signedDevice: { deviceId, venueId, kind: who.deviceKind },
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
  await app.end();
  await owner.end();
  await db.drop();
});

interface Check {
  id: string;
  count: number;
  blocking: boolean;
  names: string[];
  link: string;
}
const FRI = "2026-09-25";
const night = async () => {
  const r = await get(`/nights/${FRI}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as {
    checks: Check[];
    closed: { z_number: number } | null;
    capture_failed: unknown[];
  };
};
const check = (checks: Check[], id: string) => checks.find((c) => c.id === id)!;

describe("Close the night", () => {
  it("at Sat 4:12 AM lists the checks before closing, each linking to its fix", async () => {
    clock.set(Temporal.Instant.from("2026-09-26T04:12:00-04:00"));
    as("andy", "manager", "passkey", "dev_phone_andy");
    const { checks } = await night();
    expect(check(checks, "open_tabs")).toMatchObject({ count: 5, blocking: true });
    expect(check(checks, "on_the_clock")).toMatchObject({
      names: ["Maya S.", "Diego R."],
      link: "/clock",
    });
    expect(check(checks, "waitlist")).toMatchObject({ count: 3, blocking: true });
    expect(check(checks, "approvals")).toMatchObject({
      count: 1,
      blocking: true,
      link: "/approvals",
    });
    expect(check(checks, "unsent")).toMatchObject({ names: ["Tariq A."], blocking: true });
    expect(check(checks, "clear_out")).toMatchObject({ blocking: true });
    expect(check(checks, "drawers")).toMatchObject({ count: 2, blocking: true });
    // Paper slips not entered don't hold up the close.
    expect(check(checks, "slips")).toMatchObject({
      names: ["Dev S.", "Tom W.", "Ana R."],
      blocking: false,
      link: "/tips",
    });
    expect(check(checks, "open_rooms").count).toBeGreaterThan(0);
  });

  it("refuses the close while anything blocking is open, naming each failing check", async () => {
    const r = await post(`/nights/${FRI}/close`, {});
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("night_open");
    const ids = (r.json().error.details.checks as { id: string }[]).map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining(["open_tabs", "on_the_clock", "clear_out", "drawers"]),
    );
    expect(ids).not.toContain("slips");
  });

  it("closes once every check is fixed: Z 1, the manager clocked out, 86s and Closed tonight cleared; a capture-failed tab doesn't block", async () => {
    // Each fix, as the screens would make it.
    await owner.query(
      "update room_sessions set ended_at = now() where venue_id = $1 and ended_at is null",
      [venueId],
    );
    await owner.query(
      "update tabs set state = case when name = 'Hana K.' then 'capture_failed' else 'captured' end where venue_id = $1 and state in ('open', 'tipping')",
      [venueId],
    );
    await owner.query(
      `update shifts set ended_at = now() where venue_id = $1 and ended_at is null
         and membership_id not in (select id from memberships where user_id = $2)`,
      [venueId, ids["andy"]],
    );
    await owner.query(
      "update waitlist_entries set status = 'left' where venue_id = $1 and status in ('waiting', 'offered')",
      [venueId],
    );
    await owner.query(
      "update orders set status = 'cancelled', cancel_reason = 'staff' where venue_id = $1 and status in ('ringing', 'held')",
      [venueId],
    );
    await owner.query(
      "update approvals set status = 'declined' where venue_id = $1 and status = 'pending'",
      [venueId],
    );
    await owner.query(
      "update room_states set state = 'available' where venue_id = $1 and state = 'cleaning'",
      [venueId],
    );
    await owner.query("update order_drafts set lines = '[]' where venue_id = $1", [venueId]);
    for (const d of ["Bar drawer", "Front-desk drawer"]) {
      const s = (
        await owner.query<{ id: string }>(
          "select s.id from drawer_sessions s join cash_drawers d on d.id = s.drawer_id where d.name = $1 and s.state = 'open'",
          [d],
        )
      ).rows[0]!.id;
      expect((await post(`/drawer-sessions/${s}/count`, { counted_cents: 30000 })).statusCode).toBe(
        200,
      );
    }
    // The clear-out check is due at 4:30 AM; Andy does it at 4:31.
    let r = await post(`/nights/${FRI}/close`, {});
    expect(r.json().error.details.checks.map((c: { id: string }) => c.id)).toEqual(["clear_out"]);
    clock.set(Temporal.Instant.from("2026-09-26T04:31:00-04:00"));
    await sweepClearOut(owner, clock.now());
    expect((await post(`/nights/${FRI}/clear-out`, {})).statusCode).toBe(200);
    // A Hoegaarden 86'd tonight.
    expect(
      (
        await owner.query(
          "select 1 from menu_items where venue_id = $1 and out_until is not null",
          [venueId],
        )
      ).rowCount,
    ).toBe(3);

    // Two managers close at once: one wins.
    clock.set(Temporal.Instant.from("2026-09-26T04:48:00-04:00"));
    const [a, b] = await Promise.all([
      post(`/nights/${FRI}/close`, {}),
      post(`/nights/${FRI}/close`, {}),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const won = a.statusCode === 200 ? a : b;
    expect(won.json()).toMatchObject({ business_date: FRI, z_number: 1 });
    expect(won.json().checks).toHaveProperty("rooms");
    expect(won.json().checks).toHaveProperty("bar_tabs");

    const after = await night();
    expect(after.closed).toMatchObject({ z_number: 1 });
    // The capture-failed tab stays on the manager's list.
    expect(after.capture_failed).toHaveLength(1);
    // Andy was clocked out at the close; the 86s are back; Closed tonight is empty.
    const andyShift = await owner.query(
      `select 1 from shifts s join memberships m on m.id = s.membership_id where m.user_id = $1 and s.ended_at is null`,
      [ids["andy"]],
    );
    expect(andyShift.rowCount).toBe(0);
    expect(
      (
        await owner.query(
          "select 1 from menu_items where venue_id = $1 and out_until is not null",
          [venueId],
        )
      ).rowCount,
    ).toBe(0);
    const tabs = (await get("/tabs")).json() as { tabs: { state: string }[] };
    expect(tabs.tabs.filter((t) => t.state === "captured")).toEqual([]);
    // The pool closed with it.
    expect(
      (
        await owner.query<{ status: string }>(
          "select status from tip_pools where business_date = $1",
          [FRI],
        )
      ).rows,
    ).toEqual([{ status: "closed" }]);
    r = await post(`/nights/${FRI}/close`, {});
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
  });
});
