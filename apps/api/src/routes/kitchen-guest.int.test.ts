import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed, seedHostToken } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, Temporal } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { sweepAlcoholStop } from "../orders/four-am.js";

/**
 * Ordering food from the room (K-04; Kitchen and food · Ordering food): a guest's basket of wings
 * with an allergy note and two beers becomes a Drinks card and a Food card; Accept prints the food
 * in the kitchen at once with the note boxed, no Send to kitchen step; the guest can cancel the
 * food while it rings and nothing is charged; at 4:00 AM the drinks are cancelled as
 * alcohol_closed and the food keeps ringing; Same again includes food with the notes left empty;
 * a note never reaches the check, a text or the guest's record. The menu is a TEST one, no venue's.
 */
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
let host = "";
let n = 0;
let who: Principal | undefined;
const food: Record<string, string> = {};
const NOTE = "TEST no peanuts, severe";

const cookieOf = (h: string | string[] | undefined) =>
  String(Array.isArray(h) ? h[0] : h).split(";")[0]!;
const guest = (method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: host }, ...(payload ? { payload } : {}) });
const order = (lines: object[]) =>
  guest("POST", "/v1/public/room-session/orders", {
    client_order_id: `kitchen-guest-${++n}-abcdef`,
    lines,
  });
const staff = (method: "GET" | "POST", path: string, payload?: object) =>
  app.inject({ method, url: `/v1/venues/${venueId}${path}`, ...(payload ? { payload } : {}) });
const wings = (note?: string, allergy?: boolean) => ({
  variant_id: food["wings"],
  qty: 1,
  ...(note !== undefined ? { kitchen_note: note, kitchen_note_allergy: allergy } : {}),
});
const twoBeers = () => ({ variant_id: food["drink"], qty: 2 });
type GuestCard = { id: string; status: string; station: string; can_cancel: boolean };
const cards = async () =>
  (await guest("GET", "/v1/public/room-session/orders")).json().orders as GuestCard[];

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
  const one = async (sql: string, params: unknown[]) =>
    (await raw.query<{ id: string }>(sql, params)).rows[0]!.id;
  const cat = await one(
    "insert into menu_categories (venue_id, name, sort, tax_category) values ($1, 'TEST Wings', 900, 'food') returning id",
    [venueId],
  );
  const item = await one(
    "insert into menu_items (venue_id, category_id, name, station) values ($1, $2, 'TEST wings', 'kitchen') returning id",
    [venueId, cat],
  );
  food["wings"] = await one(
    "insert into menu_variants (venue_id, item_id, name, price_cents) values ($1, $2, 'Regular', 1200) returning id",
    [venueId, item],
  );
  food["drink"] = (
    await raw.query<{ id: string }>(
      `select v.id from menu_variants v join menu_items i on i.id = v.item_id
        where i.venue_id = $1 and i.station = 'bar' and i.alcohol and i.shown and i.out_until is null and v.out_until is null
          and not exists (select 1 from modifier_groups g where g.item_id = i.id and (g.required or g.min_choices > 0))
        order by i.name limit 1`,
      [venueId],
    )
  ).rows[0]!.id;
  await raw.query(
    "update venue_modules set allowed = true, state = 'on' where venue_id = $1 and module_id = 'kitchen'",
    [venueId],
  );
  who = {
    kind: "user",
    userId: ids["maya"]!,
    session: "pin",
    memberships: [{ venueId, membershipId: ids["maya.membership"]!, role: "bartender" }],
  };
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [async (r) => (r.url.startsWith("/v1/venues/") ? who : undefined)],
    moduleCacheMs: 0,
  });
  await app.ready();
  host = cookieOf(
    (
      await app.inject({
        method: "POST",
        url: "/v1/public/room-session/host",
        payload: { token: seedHostToken("sess_room9") },
      })
    ).headers["set-cookie"],
  );
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await raw.end();
  await db.drop();
});

describe("ordering food from the room (K-04)", () => {
  let mealId = "";

  it("a mixed basket shows as two cards, Drinks and Food, each in the guest words", async () => {
    const r = await order([twoBeers(), wings(NOTE, true)]);
    expect(r.statusCode, r.body).toBe(201);
    const placed = r.json().orders as { id: string; station: string }[];
    expect(placed.map((o) => o.station)).toEqual(["bar", "kitchen"]);
    mealId = placed[1]!.id;
    const mine = (await cards()).filter((c) => placed.some((p) => p.id === c.id));
    expect(mine.map((c) => [c.station, c.status]).sort()).toEqual([
      ["bar", "ringing"],
      ["kitchen", "ringing"],
    ]);
    const line = await raw.query<{ kitchen_note: string; kitchen_note_allergy: boolean }>(
      "select kitchen_note, kitchen_note_allergy from order_items where order_id = $1",
      [mealId],
    );
    expect(line.rows).toEqual([{ kitchen_note: NOTE, kitchen_note_allergy: true }]);
  });

  it("refuses a note for the kitchen on a drink, and one over 200 characters", async () => {
    const drink = await order([{ ...twoBeers(), kitchen_note: "TEST no ice" }]);
    expect(drink.statusCode).toBe(400);
    expect(drink.json().error.details?.reason).toBe("kitchen_note_not_food");
    const long = await order([wings("x".repeat(201), false)]);
    expect(long.statusCode).toBe(400);
  });

  it("Accept prints the food in the kitchen at once with the note boxed, and no prices", async () => {
    const r = await staff("POST", `/orders/${mealId}/accept`, {});
    expect(r.statusCode, r.body).toBe(200);
    const job = await raw.query<{ station: string; payload: Record<string, unknown> }>(
      "select station, payload from print_jobs where order_id = $1",
      [mealId],
    );
    expect(job.rows).toHaveLength(1);
    expect(job.rows[0]!.station).toBe("kitchen");
    expect(job.rows[0]!.payload).toMatchObject({
      kitchen: true,
      room: "Room 9",
      lines: [{ qty: 1, name: "TEST wings", kitchen_note: NOTE, allergy: true }],
    });
    expect(JSON.stringify(job.rows[0]!.payload)).not.toMatch(/cents|price/);
    expect((await cards()).find((c) => c.id === mealId)?.status).toBe("accepted");
    // The note is on the kitchen's slip only: never on the check, a text or the guest's record.
    const leaks = await raw.query<{ n: number }>(
      `select (select count(*) from check_lines where venue_id = $1 and description::text like '%' || $2 || '%')
            + (select count(*) from jobs where kind = 'text.send' and payload::text like '%' || $2 || '%')
            + (select count(*) from guests where venue_id = $1 and row_to_json(guests)::text like '%' || $2 || '%')
            as n`,
      [venueId, NOTE],
    );
    expect(Number(leaks.rows[0]!.n)).toBe(0);
  });

  it("the guest can cancel the food card while it's ringing, and nothing is charged", async () => {
    const r = await order([wings()]);
    const id = (r.json().orders as { id: string }[])[0]!.id;
    const card = (await cards()).find((c) => c.id === id)!;
    expect(card).toMatchObject({ station: "kitchen", can_cancel: true });
    const lines = async () =>
      Number(
        (
          await raw.query<{ n: number }>(
            "select count(*)::int as n from check_lines where check_id = (select check_id from orders where id = $1)",
            [id],
          )
        ).rows[0]!.n,
      );
    const before = await lines();
    expect((await guest("POST", `/v1/public/room-session/orders/${id}/cancel`)).statusCode).toBe(
      200,
    );
    expect((await cards()).find((c) => c.id === id)?.status).toBe("cancelled");
    expect(await lines()).toBe(before);
    expect((await raw.query("select 1 from print_jobs where order_id = $1", [id])).rowCount).toBe(
      0,
    );
  });

  it("at 4:00 AM the drinks card is cancelled as alcohol_closed and the food card keeps ringing", async () => {
    const r = await order([twoBeers(), wings()]);
    const [drinks, meal] = r.json().orders as { id: string }[];
    await sweepAlcoholStop(
      pool,
      Temporal.ZonedDateTime.from("2026-09-26T04:00:00-04:00[America/New_York]").toInstant(),
    );
    const now = await raw.query<{ id: string; status: string; cancel_reason: string | null }>(
      "select id, status, cancel_reason from orders where id = any($1::uuid[])",
      [[drinks!.id, meal!.id]],
    );
    const by = Object.fromEntries(now.rows.map((o) => [o.id, o]));
    expect(by[drinks!.id]).toMatchObject({ status: "cancelled", cancel_reason: "alcohol_closed" });
    expect(by[meal!.id]).toMatchObject({ status: "ringing" });
  });

  it("Same again includes food and leaves the notes empty", async () => {
    await raw.query("update orders set status = 'delivered', delivered_at = now() where id = $1", [
      mealId,
    ]);
    const list = (await guest("GET", "/v1/public/room-session/same-again")).json() as {
      rounds: { order_id: string; lines: { name: string }[] }[];
    };
    const round = list.rounds.find((x) => x.order_id === mealId);
    expect(round?.lines.map((l) => l.name)).toEqual(["TEST wings"]);
    const r = await guest("POST", "/v1/public/room-session/same-again", {
      order_id: mealId,
      client_order_id: `kitchen-again-${++n}-abcdef`,
    });
    expect(r.statusCode, r.body).toBe(201);
    const again = await raw.query<{
      station: string;
      kitchen_note: string | null;
      allergy: boolean;
    }>(
      `select o.station, i.kitchen_note, i.kitchen_note_allergy as allergy
         from orders o join order_items i on i.order_id = o.id
        where o.same_again_of = $1`,
      [mealId],
    );
    expect(again.rows).toEqual([{ station: "kitchen", kitchen_note: null, allergy: false }]);
  });
});
