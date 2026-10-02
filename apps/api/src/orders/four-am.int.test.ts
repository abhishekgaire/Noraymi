import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { insertOrder, loadDemoSeed, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, Temporal, guestOrderWords, t } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { sweepAlcoholStop } from "./four-am.js";

/** M3-22, spec 13's clock tests: the 4:00 AM stop on a normal night and both daylight-saving nights. */
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
const at = (iso: string) => Temporal.Instant.from(iso);
const statusOf = async (id: string) =>
  (
    await raw.query<{ status: string; cancel_reason: string | null }>(
      "select status, cancel_reason from orders where id = $1",
      [id],
    )
  ).rows[0]!;

async function ringing(
  placedAt: string,
  items: { name: string; alcohol: boolean; variant: string; item: string }[],
) {
  return withVenue(pool, { venueId }, (c) =>
    insertOrder(c, venueId, {
      checkId: ids["chk_room9"]!,
      sessionId: ids["sess_room9"]!,
      source: "room",
      placedAt,
      businessDate: "2026-09-25",
      items: items.map((i) => ({
        variantId: ids[i.variant]!,
        itemId: ids[i.item]!,
        options: [],
        qty: 1,
        unitCents: 1300,
        name: i.name,
        alcohol: i.alcohol,
        taxCategory: "drink",
        station: "bar",
      })),
    }),
  );
}
const marg = { name: "Margarita", alcohol: true, variant: "menu_marg_regular", item: "menu_marg" };
const redBull = {
  name: "Red Bull",
  alcohol: false,
  variant: "menu_redbull_regular",
  item: "menu_redbull",
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

describe("the 4:00 AM stop", () => {
  it("on Fri Sep 25: nothing at 3:59:59, then at 4:00:00 every unaccepted alcohol order cancels itself", async () => {
    const mixed = await ringing("2026-09-26T03:50:00-04:00", [marg, redBull]);
    expect(await sweepAlcoholStop(pool, at("2026-09-26T03:59:59-04:00"))).toBe(0);
    expect(await sweepAlcoholStop(pool, at("2026-09-26T04:00:00-04:00"))).toBe(3);
    for (const o of [ids["order_o1"]!, ids["order_o2"]!, mixed])
      expect(await statusOf(o)).toEqual({ status: "cancelled", cancel_reason: "alcohol_closed" });
    expect(
      t("en", guestOrderWords({ status: "cancelled", cancel_reason: "alcohol_closed" }).key),
    ).toBe("The bar stopped serving alcohol at 4 AM · your order was cancelled, nothing charged");
    // The Margarita and Red Bull order keeps ringing with the Red Bull alone.
    const kept = await raw.query<{ status: string; items: string[] }>(
      `select o.status, array_agg(i.name_snapshot) as items from orders o join order_items i on i.order_id = o.id
        where o.session_id = $1 and o.status = 'ringing' group by o.id, o.status`,
      [ids["sess_room9"]],
    );
    expect(kept.rows).toEqual([{ status: "ringing", items: ["Red Bull"] }]);
    // Nothing charged.
    const lines = await raw.query<{ n: number }>(
      "select count(*)::int as n from check_lines where check_id = $1 and description like 'Margarita%'",
      [ids["chk_room9"]],
    );
    expect(lines.rows[0]!.n).toBe(0);
  });

  it("from 4:00 AM there's no Decline, and every alcohol route answers 409 alcohol_closed", async () => {
    clock.set(at("2026-09-26T04:00:05-04:00"));
    const late = await ringing("2026-09-26T04:00:01-04:00", [marg]);
    const decline = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/orders/${late}/decline`,
      payload: { reason: "Too late" },
    });
    expect(decline.statusCode).toBe(409);
    expect(decline.json().error.code).toBe("alcohol_closed");
    const staffOrder = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/checks/${ids["chk_room9"]}/orders`,
      payload: { lines: [{ variant_id: ids["menu_bud_regular"], qty: 1 }] },
    });
    expect(staffOrder.statusCode).toBe(409);
    expect(
      (await app.inject({ method: "GET", url: `/v1/venues/${venueId}/menu` })).json().alcohol.state,
    ).toBe("closed");
  });

  it("on the fall-back night (Sat Oct 31, 2026): at 4:00:00 AM EST on Nov 1", async () => {
    const o = await ringing("2026-11-01T03:30:00-05:00", [marg]);
    await sweepAlcoholStop(pool, at("2026-11-01T03:59:59-05:00"));
    expect((await statusOf(o)).status).toBe("ringing");
    await sweepAlcoholStop(pool, at("2026-11-01T04:00:00-05:00"));
    expect(await statusOf(o)).toEqual({ status: "cancelled", cancel_reason: "alcohol_closed" });
  });

  it("on the spring-forward night (Sat Mar 13, 2027): at 4:00:00 AM EDT on Mar 14, not 5:00", async () => {
    const o = await ringing("2027-03-14T03:30:00-04:00", [marg]);
    await sweepAlcoholStop(pool, at("2027-03-14T03:59:59-04:00"));
    expect((await statusOf(o)).status).toBe("ringing");
    await sweepAlcoholStop(pool, at("2027-03-14T04:00:00-04:00"));
    expect(await statusOf(o)).toEqual({ status: "cancelled", cancel_reason: "alcohol_closed" });
  });
});
