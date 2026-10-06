import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  LOCAL_DEV_AUTH_KEY as KEY,
  generateSigningKey,
  loadDemoSeed,
  publishRulePack,
  recordNightClose,
  withVenue,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, Temporal, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { closePool } from "../tips/pool.js";
import type { Principal, SessionKind } from "../http/principal.js";

/**
 * The tip pool (M7-09; Money rules 1 and 9): Maya and Diego share Friday's
 * tips by their minutes, Andy and Abhishek never do, a method change starts
 * the next night, late tips reach the night they were earned without changing
 * its closed pool, and every source's shares add up to the cent.
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

interface Tips {
  pool: { method: string; status: string };
  sources: {
    gratuity_cents: number;
    card_tip_cents: number;
    cash_tip_cents: number;
    total_cents: number;
  };
  shares: {
    for_business_date: string;
    name: string;
    duty: string;
    minutes: number;
    gratuity_cents: number;
    card_tip_cents: number;
    cash_tip_cents: number;
  }[];
  left_out: { name: string; reason: string }[];
}
const tips = async (date: string) => {
  as("andy", "manager", "passkey", "dev_phone_andy");
  const r = await api.inject({ method: "GET", url: `/v1/venues/${venueId}/nights/${date}/tips` });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as Tips;
};
/** Every source's shares add up to the cent. */
const addsUp = (t: Tips) => {
  const sum = (k: "gratuity_cents" | "card_tip_cents" | "cash_tip_cents") =>
    t.shares.reduce((s, x) => s + x[k], 0);
  expect(sum("gratuity_cents")).toBe(t.sources.gratuity_cents);
  expect(sum("card_tip_cents")).toBe(t.sources.card_tip_cents);
  expect(sum("cash_tip_cents")).toBe(t.sources.cash_tip_cents);
};
const FRI = "2026-09-25";
const SAT = "2026-09-26";

describe("the tip pool", () => {
  it("shares Friday's tips between Maya and Diego by their minutes; Andy and Abhishek never share", async () => {
    await owner.query(
      "update orders set status = 'cancelled', cancel_reason = 'guest' where id = $1",
      [ids["order_o1"]],
    );
    as("diego", "front_desk", "pin", "dev_front_computer");
    expect((await post(`/checks/${ids["chk_room9"]}/present`)).statusCode).toBe(200);
    const paid = await post(`/checks/${ids["chk_room9"]}/payments`, {
      method: "cash",
      amount_cents: 49860,
      tip_cents: 500,
      tendered_cents: 50360,
    });
    expect(paid.statusCode, paid.body).toBe(201);
    // A practice tip never reaches the pool.
    await owner.query(
      `insert into payments (venue_id, method, status, amount_cents, tip_cents, business_date, training)
       values ($1, 'cash', 'captured', 1000, 700, $2, true)`,
      [venueId, FRI],
    );
    const t = await tips(FRI);
    expect(t.pool).toMatchObject({ method: "hours", status: "open" });
    expect(t.sources).toMatchObject({ gratuity_cents: 9600, cash_tip_cents: 500 });
    expect(t.shares.map((s) => [s.name, s.duty, s.minutes])).toEqual([
      ["Maya S.", "bar", 401],
      ["Diego R.", "front_desk", 221],
    ]);
    expect(t.left_out).toEqual([{ name: "Andy C.", reason: "manager" }]);
    addsUp(t);
  });

  it("switching to even on Fri Sep 25 starts on Sat Sep 26, and Friday's pool still splits by hours", async () => {
    as("abhishek", "owner", "passkey", "dev_phone_abhishek");
    const current = (
      await api.inject({ method: "GET", url: `/v1/venues/${venueId}/settings/pay` })
    ).json() as { value: Record<string, unknown> };
    const r = await api.inject({
      method: "PUT",
      url: `/v1/venues/${venueId}/settings/pay`,
      headers: { "idempotency-key": `pool-${++n}` },
      payload: { value: { ...current.value, pool: "even" } },
    });
    expect(r.statusCode, r.body).toBe(200);
    const history = (
      await api.inject({ method: "GET", url: `/v1/venues/${venueId}/settings/pay?history=1` })
    ).json() as { versions: { startsOn: string; value: { pool: string } }[] };
    expect(history.versions[0]).toMatchObject({ startsOn: SAT, value: { pool: "even" } });
    expect((await tips(FRI)).pool.method).toBe("hours");
  });

  it("splits Saturday's late slip tips by Friday's people and minutes, in Saturday's pool, and Friday's closed pool stays as it was", async () => {
    clock.set(Temporal.Instant.from("2026-09-26T04:48:00-04:00"));
    const friday = await withVenue(app, { venueId }, async (c) => {
      const closed = await closePool(c, venueId, FRI, clock.now());
      await recordNightClose(c, venueId, {
        businessDate: FRI,
        closedAt: clock.now().toString(),
        closedBy: ids["andy"]!,
      });
      return closed;
    });
    expect(friday.pool.status).toBe("closed");
    // The three slips' tips, entered after the close: they post to Saturday and point at Friday.
    await withVenue(app, { venueId }, (c) =>
      c.query(
        `insert into tip_ledger (venue_id, business_date, adjusts_business_date, source, amount_cents)
         values ($1, $2, $3, 'card_tip', 2401)`,
        [venueId, SAT, FRI],
      ),
    );
    const sat = await tips(SAT);
    expect(sat.sources.card_tip_cents).toBe(2401);
    expect(sat.shares.every((s) => s.for_business_date === FRI)).toBe(true);
    expect(sat.shares.map((s) => s.name)).toEqual(["Maya S.", "Diego R."]);
    addsUp(sat);
    const after = await tips(FRI);
    expect(after.pool.status).toBe("closed");
    expect(after.shares).toEqual(friday.shares);
    await expect(
      withVenue(app, { venueId }, async (c) => {
        const pool = (
          await c.query<{ id: string }>("select id from tip_pools where business_date = $1", [FRI])
        ).rows[0]!.id;
        await c.query(
          `insert into tip_shares (venue_id, pool_id, for_business_date, user_id, duty, minutes, gratuity_cents,
             card_tip_cents, cash_tip_cents) values ($1, $2, $3, $4, 'bar', 1, 1, 0, 0)`,
          [venueId, pool, FRI, ids["maya"]],
        );
      }),
    ).rejects.toMatchObject({ code: "W4P01" });
  });

  it("passes the money cases through the pool: Maya 560 min and Diego 330 min split $1,000.01 as $629.22 and $370.79", async () => {
    const SUN = "2026-09-27";
    const shift = async (slug: string, duty: string, from: string, to: string) => {
      const m = (
        await owner.query<{ id: string }>("select id from memberships where user_id = $1", [
          ids[slug],
        ])
      ).rows[0]!.id;
      const punch = (
        await owner.query<{ id: string }>(
          "insert into time_punches (venue_id, membership_id, kind, duty, at) values ($1, $2, 'clock_in', $3, $4) returning id",
          [venueId, m, duty, from],
        )
      ).rows[0]!.id;
      await owner.query(
        `insert into shifts (venue_id, membership_id, clock_in_punch_id, business_date, duty, started_at, ended_at)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [venueId, m, punch, SUN, duty, from, to],
      );
    };
    await shift("maya", "bar", "2026-09-27T18:00:00-04:00", "2026-09-28T03:20:00-04:00");
    await shift("diego", "front_desk", "2026-09-27T19:00:00-04:00", "2026-09-28T00:30:00-04:00");
    await owner.query(
      "insert into tip_ledger (venue_id, business_date, source, amount_cents) values ($1, $2, 'gratuity', 100001)",
      [venueId, SUN],
    );
    clock.set(Temporal.Instant.from("2026-09-28T05:00:00-04:00"));
    // Sunday's pool opens with the even split saved on Friday; the money case is by hours.
    await tips(SUN);
    await owner.query("update tip_pools set method = 'hours' where business_date = $1", [SUN]);
    const again = await tips(SUN);
    expect(again.pool.method).toBe("hours");
    expect(again.shares.map((s) => [s.name, s.minutes, s.gratuity_cents])).toEqual([
      ["Maya S.", 560, 62922],
      ["Diego R.", 330, 37079],
    ]);
    addsUp(again);
  });
});
