import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { insertOrder, loadDemoSeed, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, guestOrderWords, t } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/** M3-06 acceptance on the demo seed: Accept is the sale, the steps in order, cancels, declines, returns. */
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
let who: Principal;
const req = (method: "GET" | "POST", path: string, payload?: object) =>
  app.inject({ method, url: `/v1/venues/${venueId}${path}`, ...(payload ? { payload } : {}) });
const step = (order: string, s: string, payload: object = {}) =>
  req("POST", `/orders/${order}/${s}`, payload);
const check = async (slug: string) =>
  (await req("GET", `/checks/${ids[slug]}`)).json<{
    lines_cents: number;
    tab_so_far_cents: number;
    lines: { kind: string; amount_cents: number; description: string }[];
  }>();
const printJobs = async (order: string) =>
  (
    await raw.query<{ n: number }>(
      "select count(*)::int as n from print_jobs where order_id = $1 and kind = 'ticket'",
      [order],
    )
  ).rows[0]!.n;

/** A ringing order of Bud Lights on Room 5, as a guest would place it. */
async function newOrder(qty = 1) {
  return withVenue(pool, { venueId }, (c) =>
    insertOrder(c, venueId, {
      checkId: ids["chk_room5"]!,
      sessionId: ids["sess_room5"]!,
      source: "room",
      placedAt: SEED_NOW.toString(),
      businessDate: "2026-09-25",
      items: [
        {
          variantId: ids["menu_bud_regular"]!,
          itemId: ids["menu_bud"]!,
          options: [],
          qty,
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
  who = {
    kind: "user",
    userId: ids["maya"]!,
    session: "pin",
    memberships: [{ venueId, membershipId: ids["maya.membership"]!, role: "bartender" }],
  };
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [async () => who],
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

describe("the order pipeline", () => {
  it("the bar's Waiting list has o2 then o1, and the Runs have o4 and o3 ready", async () => {
    const waiting = (await req("GET", "/orders?status=ringing,held")).json<{
      orders: { id: string; room_name: string; amount_cents: number }[];
    }>().orders;
    expect(waiting.map((o) => o.id)).toEqual([ids["order_o2"], ids["order_o1"]]);
    expect(waiting.map((o) => o.room_name)).toEqual(["Room 5", "Room 9"]);
    const runs = (await req("GET", "/orders?status=ready,on_the_way")).json<{
      orders: { id: string }[];
    }>().orders;
    expect(runs.map((o) => o.id).sort()).toEqual([ids["order_o3"], ids["order_o4"]].sort());
  });

  it("accepting o1 puts it on Room 9's check at that moment, at the price it was ordered, with a ticket", async () => {
    // A price change after the order was placed doesn't change the order.
    await raw.query("update menu_variants set price_cents = 1500 where id = $1", [
      ids["menu_marg_regular"],
    ]);
    const before = await check("chk_room9");
    expect(before.lines_cents).toBe(15800);
    expect(before.tab_so_far_cents).toBe(48000);
    const events = async () =>
      (
        await raw.query<{ n: number }>(
          "select count(*)::int as n from venue_events where type = 'order.accepted'",
        )
      ).rows[0]!.n;
    const eventsBefore = await events();
    const r = await step(ids["order_o1"]!, "accept");
    expect(r.statusCode).toBe(200);
    expect(r.json().order).toMatchObject({ status: "accepted", accepted_by: ids["maya"] });
    const after = await check("chk_room9");
    expect(after.lines_cents).toBe(18400);
    expect(after.tab_so_far_cents).toBe(50600);
    expect(after.lines.at(-1)).toMatchObject({
      kind: "item",
      description: "Margarita · Peach",
      amount_cents: 2600,
    });
    expect(await printJobs(ids["order_o1"]!)).toBe(1);
    expect(await events()).toBe(eventsBefore + 1);
    await raw.query("update menu_variants set price_cents = 1300 where id = $1", [
      ids["menu_marg_regular"],
    ]);
  });

  it("o2 asked to wait stays in Waiting, and Ready, claim and Deliver answer 409", async () => {
    const o2 = ids["order_o2"]!;
    expect((await step(o2, "hold")).json().order.status).toBe("held");
    const waiting = (await req("GET", "/orders?status=ringing,held")).json<{
      orders: { id: string; status: string; placed_at: string }[];
    }>().orders;
    expect(waiting.find((o) => o.id === o2)).toMatchObject({ status: "held" });
    for (const s of ["ready", "claim", "deliver"]) {
      const r = await step(o2, s);
      expect(r.statusCode, s).toBe(409);
      expect(r.json().error.code).toBe("version_conflict");
    }
    expect((await check("chk_room5")).lines_cents).toBe(0);
  });

  it("the guest can cancel while ringing or held, not once accepted; nothing is charged", async () => {
    const ringing = await newOrder();
    const r = await step(ringing, "cancel", { for: "guest" });
    expect(r.json().order).toMatchObject({ status: "cancelled", cancel_reason: "guest" });
    expect((await step(ids["order_o2"]!, "cancel", { for: "guest" })).json().order.status).toBe(
      "cancelled",
    );
    expect((await step(ids["order_o1"]!, "cancel", { for: "guest" })).statusCode).toBe(409);
    expect((await check("chk_room5")).lines_cents).toBe(0);
  });

  it("a decline needs a reason; with one, the guest sees the glossary's sentence and the reason", async () => {
    const o = await newOrder();
    expect((await step(o, "decline", { reason: " " })).statusCode).toBe(400);
    const r = await step(o, "decline", { reason: "Out of peach" });
    const order = r.json().order;
    expect(order).toMatchObject({ status: "cancelled", cancel_reason: "declined" });
    const words = guestOrderWords(order);
    expect(t("en", words.key)).toBe("The bar couldn't take this order · nothing charged");
    expect(words.reason).toBe("Out of peach");
  });

  it("a return tells the manager on duty; void · made writes a VOID line with made true", async () => {
    const o = await newOrder();
    for (const s of ["accept", "ready", "claim"])
      expect((await step(o, s)).statusCode, s).toBe(200);
    const pushes = async () =>
      (
        await raw.query<{ n: number }>(
          "select count(*)::int as n from jobs where kind = 'push.send'",
        )
      ).rows[0]!.n;
    const pushesBefore = await pushes();
    const back = await step(o, "return", { reason: "too_drunk" });
    expect(back.json().order).toMatchObject({ status: "returned", returned_reason: "too_drunk" });
    expect(await pushes()).toBe(pushesBefore + 1);
    const before = (await check("chk_room5")).lines_cents;
    const r = await step(o, "resolve", { resolution: "void_made" });
    expect(r.statusCode).toBe(200);
    expect(r.json().order).toMatchObject({ status: "returned", return_resolution: "void_made" });
    const voids = await raw.query<{ amount_cents: string; made: boolean; reason: string }>(
      "select amount_cents, made, reason from check_lines where kind = 'void' and check_id = $1",
      [ids["chk_room5"]],
    );
    expect(voids.rows).toEqual([
      { amount_cents: "-800", made: true, reason: "Couldn't serve: Someone looks too drunk" },
    ]);
    expect((await check("chk_room5")).lines_cents).toBe(before - 800);
  });

  it("remake sends it back to accepted with a new ticket and no new line", async () => {
    const o = await newOrder();
    for (const s of ["accept", "ready"]) await step(o, s);
    await step(o, "return", { reason: "nobody_there" });
    const lines = (await check("chk_room5")).lines.length;
    const r = await step(o, "resolve", { resolution: "remake" });
    expect(r.json().order).toMatchObject({ status: "accepted", return_resolution: "remake" });
    expect(await printJobs(o)).toBe(2);
    expect((await check("chk_room5")).lines.length).toBe(lines);
    expect((await step(o, "ready")).json().order.status).toBe("ready");
  });

  it("o4's $36.00 void is over the $25 reason-only limit, so it waits for approval", async () => {
    const o4 = ids["order_o4"]!;
    await step(o4, "return", { reason: "no_id" });
    const r = await step(o4, "resolve", { resolution: "void_not_made" });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ status: "approval_pending" });
    const pending = await raw.query<{ kind: string; amount_cents: string }>(
      "select kind, amount_cents::text from approvals where target_id = $1",
      [o4],
    );
    expect(pending.rows).toEqual([{ kind: "void", amount_cents: "3600" }]);
  });

  it("delivering never charges", async () => {
    const o3 = ids["order_o3"]!;
    const before = (await check("chk_room3")).lines_cents;
    expect((await step(o3, "deliver")).json().order.status).toBe("delivered");
    expect((await check("chk_room3")).lines_cents).toBe(before);
  });
});
