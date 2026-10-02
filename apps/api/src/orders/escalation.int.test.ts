import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { insertOrder, loadDemoSeed, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, Temporal } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { sweepEscalations } from "./escalation.js";

/** M3-16 on the simulated clock: an order placed at 10:41:00 PM that nobody accepts. */
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
const at = (hms: string) => Temporal.Instant.from(`2026-09-25T${hms}-04:00`);

async function placeAt(when: Temporal.Instant): Promise<string> {
  return withVenue(pool, { venueId }, (c) =>
    insertOrder(c, venueId, {
      checkId: ids["chk_room5"]!,
      sessionId: ids["sess_room5"]!,
      source: "room",
      placedAt: when.toString(),
      businessDate: "2026-09-25",
      items: [
        {
          variantId: ids["menu_bud_regular"]!,
          itemId: ids["menu_bud"]!,
          options: [],
          qty: 4,
          unitCents: 800,
          name: "Bud Light",
          alcohol: true,
          taxCategory: "drink",
          station: "bar",
        },
      ],
    }),
  );
}
const pushes = async (key: string) =>
  (
    await raw.query<{ payload: { audience: { kind: string; role?: string; user_id?: string } } }>(
      "select payload from jobs where kind = 'push.send' and payload->'message'->>'key' = $1",
      [key],
    )
  ).rows.map((r) => r.payload.audience);
const texts = async () =>
  (
    await raw.query<{ payload: { to: string; template: string } }>(
      "select payload from jobs where kind = 'text.send' and payload->>'template' = 'order_waiting'",
    )
  ).rows.map((r) => r.payload);
const orderAlert = async (orderId: string) => {
  const board = (
    await app.inject({ method: "GET", url: `/v1/venues/${venueId}/board` })
  ).json() as {
    alerts: {
      kind: string;
      order_id?: string;
      color: string;
      told: string | null;
      manager: string | null;
      age_sec: number;
    }[];
  };
  return board.alerts.find((a) => a.kind === "order" && a.order_id === orderId);
};

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  pool = appPool(db.url);
  ids = Object.fromEntries(
    (
      await raw.query<{ slug: string; id: string }>(
        "select slug, row_id as id from seed_ids where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.slug, r.id]),
  );
  // The seed's own ringing orders are accepted, so only this test's order escalates; Andy's phone is verified.
  await raw.query(
    "update orders set status = 'cancelled', cancel_reason = 'staff' where status in ('ringing', 'held')",
  );
  await raw.query(
    "update users set phone_e164 = '+12125550166', phone_verified_at = now() where id = $1",
    [ids["andy"]],
  );
  const maya: Principal = {
    kind: "user",
    userId: ids["maya"]!,
    session: "pin",
    memberships: [{ venueId, membershipId: ids["maya.membership"]!, role: "bartender" }],
  };
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [async () => maya],
    moduleCacheMs: 0,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await raw.end();
  await db.drop();
});

describe("escalating an order nobody accepts", () => {
  it("buzzes bar phones at 10:41:30, the board at 10:43, Andy's phone at 10:45, texts him at 10:47", async () => {
    const order = await placeAt(at("22:41:00"));
    clock.set(at("22:41:29"));
    await sweepEscalations(pool, clock.now());
    expect(await pushes("orders.push.ringing")).toEqual([]);

    clock.set(at("22:41:30"));
    await sweepEscalations(pool, clock.now());
    expect((await pushes("orders.push.ringing")).map((a) => a.role).sort()).toEqual([
      "bartender",
      "front_desk",
    ]);
    expect(await orderAlert(order)).toBeUndefined();

    clock.set(at("22:43:00"));
    await sweepEscalations(pool, clock.now());
    expect(await orderAlert(order)).toMatchObject({ color: "amber", told: null, age_sec: 120 });

    clock.set(at("22:45:00"));
    await sweepEscalations(pool, clock.now());
    expect((await pushes("orders.push.waiting")).map((a) => a.user_id)).toEqual([ids["andy"]]);
    expect(await orderAlert(order)).toMatchObject({
      color: "pink",
      told: "phone",
      manager: "Andy",
    });

    clock.set(at("22:47:00"));
    await sweepEscalations(pool, clock.now());
    expect(await texts()).toEqual([
      expect.objectContaining({ to: "+12125550166", template: "order_waiting" }),
    ]);
    expect(await orderAlert(order)).toMatchObject({ told: "texted", manager: "Andy" });
    // Each step happens once.
    await sweepEscalations(pool, clock.now());
    expect(await texts()).toHaveLength(1);
    expect(await pushes("orders.push.ringing")).toHaveLength(2);
  });

  it("an asked-to-wait order keeps escalating, and Accept stops everything", async () => {
    clock.set(at("22:50:00"));
    const order = await placeAt(at("22:50:00"));
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/venues/${venueId}/orders/${order}/hold`,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    clock.set(at("22:52:00"));
    await sweepEscalations(pool, clock.now());
    expect(await orderAlert(order)).toMatchObject({ color: "amber" });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/venues/${venueId}/orders/${order}/accept`,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    const before = (await pushes("orders.push.waiting")).length;
    clock.set(at("22:58:00"));
    await sweepEscalations(pool, clock.now());
    expect(await orderAlert(order)).toBeUndefined();
    expect(await pushes("orders.push.waiting")).toHaveLength(before);
  });
});
