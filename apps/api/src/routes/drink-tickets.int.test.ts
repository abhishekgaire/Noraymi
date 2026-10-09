import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  generateSigningKey,
  insertOrder,
  loadDemoSeed,
  publishRulePack,
  withVenue,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/**
 * Drink tickets (M6-29; D99; spec 10 · Ringing and Admin → Bar POS; spec 09 · Tickets): Send on a
 * bar tab or a quick sale prints no bar ticket unless "Print tickets for drinks rung at the bar"
 * (`pos.printBarDrinkTickets`) is on; room orders, from guests or from staff, always print. The
 * setting is off for West 4, managers and the owner change it, and a change is live at once.
 */
let db: TestDatabase;
let owner: pg.Pool;
let pool: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
let who: Principal | undefined;
let n = 0;
const clock = new SimulatedClock(SEED_NOW);
const as = (slug: string, role: string, session: "passkey" | "pin" = "passkey") => {
  who = {
    kind: "user",
    userId: ids[slug]!,
    session,
    memberships: [{ venueId, membershipId: ids[`${slug}.membership`]!, role } as never],
  };
};
const call = (method: "GET" | "POST" | "PUT", path: string, payload?: object) =>
  api.inject({ method, url: `/v1/venues/${venueId}${path}`, ...(payload ? { payload } : {}) });
const pos = async () =>
  (await call("GET", "/settings/pos")).json().value as Record<string, unknown>;
const setTickets = (on: boolean) =>
  pos().then((current) =>
    call("PUT", "/settings", { values: { pos: { ...current, printBarDrinkTickets: on } } }),
  );
const modelo = () => [{ variant_id: ids["menu_modelo_regular"]!, qty: 1 }];
/** Send a round on a check: a bar tab, or a room's check from its tab or Open in the bar POS. */
const send = async (check: string) => {
  const r = await call("POST", `/checks/${ids[check]}/orders`, {
    client_order_id: `drink-tickets-${++n}`,
    lines: modelo(),
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().order.id as string;
};
const quickSale = async () => {
  const r = await call("POST", "/quick-sales", {
    client_order_id: `drink-tickets-quick-${++n}`,
    lines: modelo(),
  });
  expect(r.statusCode, r.body).toBe(201);
  const order = await owner.query<{ id: string }>("select id from orders where check_id = $1", [
    r.json().check_id,
  ]);
  return order.rows[0]!.id;
};
const tickets = async (order: string) =>
  (
    await owner.query<{ n: number }>(
      "select count(*)::int as n from print_jobs where order_id = $1 and kind = 'ticket'",
      [order],
    )
  ).rows[0]!.n;
const onCheck = async (order: string) =>
  (
    await owner.query<{ n: number }>(
      `select count(*)::int as n from check_lines l join order_items i on i.id = l.source_id
        where l.kind = 'item' and i.order_id = $1`,
      [order],
    )
  ).rows[0]!.n;

/** A ringing guest order from Room 9, as the room's phone places it, then Accept. */
async function guestOrderAccepted(): Promise<string> {
  const order = await withVenue(pool, { venueId }, (c) =>
    insertOrder(c, venueId, {
      checkId: ids["chk_room9"]!,
      sessionId: ids["sess_room9"]!,
      source: "room",
      placedAt: SEED_NOW.toString(),
      businessDate: "2026-09-25",
      items: [
        {
          variantId: ids["menu_bud_regular"]!,
          itemId: ids["menu_bud"]!,
          options: [],
          qty: 1,
          unitCents: 800,
          name: "Bud Light",
          alcohol: true,
          taxCategory: "drink",
          station: "bar",
        },
      ],
    }),
  );
  const r = await call("POST", `/orders/${order}/accept`, {});
  expect(r.statusCode, r.body).toBe(200);
  return order;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  pool = appPool(db.url);
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
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    moduleCacheMs: 0,
    authenticators: [async () => who],
  });
  await api.ready();
});

afterAll(async () => {
  await api.close();
  await pool.end();
  await owner.end();
  await db.drop();
});

describe("drink tickets (M6-29)", () => {
  it("West 4 has the setting off, and a bartender can't turn it on", async () => {
    as("abhishek", "owner");
    expect((await pos())["printBarDrinkTickets"]).toBe(false);
    as("maya", "bartender", "pin");
    const r = await setTickets(true);
    expect(r.statusCode).toBe(403);
    as("abhishek", "owner");
    expect((await pos())["printBarDrinkTickets"]).toBe(false);
  });

  it("off: Send on Jess P.'s tab and a quick sale put the drinks on and print nothing", async () => {
    as("maya", "bartender", "pin");
    const tab = await send("chk_t1");
    expect(await onCheck(tab)).toBe(1);
    expect(await tickets(tab)).toBe(0);
    const sale = await quickSale();
    expect(await onCheck(sale)).toBe(1);
    expect(await tickets(sale)).toBe(0);
  });

  it("off: Room 9's guest order at Accept, a drink from Room 9's tab and a round rung for Room 9 in the bar POS all print", async () => {
    as("maya", "bartender", "pin");
    expect(await tickets(await guestOrderAccepted())).toBe(1);
    // The room tab on a phone and Open in the bar POS both send on Room 9's check.
    expect(await tickets(await send("chk_room9"))).toBe(1);
    expect(await tickets(await send("chk_room9"))).toBe(1);
  });

  it("a manager turns it on and the next Send prints at once; turned off, the next doesn't", async () => {
    as("andy", "manager");
    const on = await setTickets(true);
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().saved[0].startsOn).toBe("2026-09-25");
    as("maya", "bartender", "pin");
    expect(await tickets(await send("chk_t1"))).toBe(1);
    expect(await tickets(await quickSale())).toBe(1);
    expect(await tickets(await send("chk_room9"))).toBe(1);
    as("andy", "manager");
    expect((await setTickets(false)).statusCode).toBe(200);
    as("maya", "bartender", "pin");
    expect(await tickets(await send("chk_t1"))).toBe(0);
  });
});
