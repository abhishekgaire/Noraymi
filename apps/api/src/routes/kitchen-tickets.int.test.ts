import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { insertBasket, loadDemoSeed, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { sweepPrintJobs } from "./print.js";

/**
 * Kitchen tickets (K-03; Kitchen and food · Kitchen tickets; spec 09 · Tickets and Outages) on the
 * fake CloudPRNT printers: a mixed basket prints one bar and one kitchen ticket; the kitchen one
 * shows each line's note, an allergy boxed and bold, and no prices. A kitchen ticket that doesn't
 * print is listed for the bar and pushed to the manager on duty; Reprint goes to the kitchen again
 * or to the bar instead, numbered REPRINT 2, 3, and never touches the check. A replayed food order
 * prints AFTER OUTAGE. West 4's seed has no kitchen: the menu below is a TEST one, no venue's.
 */
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
let who: Principal;
const food: Record<string, string> = {};

const as = (slug: string, role: string, session: "passkey" | "pin"): Principal => ({
  kind: "user",
  userId: ids[slug]!,
  session,
  memberships: [{ venueId, membershipId: ids[`${slug}.membership`]!, role: role as never }],
});
const staff = (method: "GET" | "POST", path: string, payload?: object) =>
  app.inject({ method, url: `/v1/venues/${venueId}${path}`, ...(payload ? { payload } : {}) });
interface Printer {
  device_id: string;
  username: string;
  password: string;
}
const basic = (p: Printer) =>
  `Basic ${Buffer.from(`${p.username}:${p.password}`).toString("base64")}`;
let bar: Printer;
let kitchen: Printer;

/** A CloudPRNT poll: the next job's media types, then its content in the first type offered. */
async function poll(p: Printer, type?: string) {
  const r = await app.inject({
    method: "POST",
    url: "/v1/print/cloudprnt",
    headers: { authorization: basic(p) },
    payload: {
      status: "23 6 0 0 0 0 0 0 0",
      printerMAC: "00:11:62:aa:bb:cc",
      statusCode: "200 OK",
    },
  });
  expect(r.statusCode).toBe(200);
  if (!r.json().jobReady) return null;
  const token = r.json().jobToken as string;
  const media = r.json().mediaTypes as string[];
  const job = await app.inject({
    method: "GET",
    url: `/v1/print/cloudprnt?type=${encodeURIComponent(type ?? media[0]!)}&token=${token}`,
    headers: { authorization: basic(p) },
  });
  return { id: token, media, contentType: String(job.headers["content-type"]), text: job.body };
}
async function confirm(p: Printer, id: string) {
  const r = await app.inject({
    method: "DELETE",
    url: `/v1/print/cloudprnt?code=200%20OK&token=${id}`,
    headers: { authorization: basic(p) },
  });
  expect(r.statusCode).toBe(200);
}

const wings = (note: string | null, allergy: boolean) => ({
  variantId: food["wings"]!,
  itemId: food["wingsItem"]!,
  options: [{ group: "Add", name: "TEST fries", price_delta_cents: 300 }],
  qty: 1,
  unitCents: 1200,
  name: "TEST wings",
  alcohol: false,
  taxCategory: "food",
  station: "kitchen",
  kitchenNote: note,
  kitchenNoteAllergy: allergy,
});
const side = (note: string | null) => ({
  variantId: food["side"]!,
  itemId: food["sideItem"]!,
  options: [],
  qty: 2,
  unitCents: 500,
  name: "TEST side",
  alcohol: false,
  taxCategory: "food",
  station: "kitchen",
  kitchenNote: note,
});
const beers = {
  variantId: ids["menu_bud_regular"] ?? "",
  itemId: ids["menu_bud"] ?? "",
  options: [],
  qty: 2,
  unitCents: 800,
  name: "Bud Light",
  alcohol: true,
  taxCategory: "drink",
  station: "bar",
};

/** A basket on Room 5's check, placed as a guest's (or replayed offline) order: its order ids, bar first. */
async function basket(items: object[], source = "room"): Promise<string[]> {
  return withVenue(pool, { venueId }, (c) =>
    insertBasket(c, venueId, {
      checkId: ids["chk_room5"]!,
      sessionId: ids["sess_room5"]!,
      source,
      placedAt: clock.now().toString(),
      businessDate: "2026-09-25",
      items: items as never,
    }),
  );
}
const accept = async (orderId: string) => {
  who = as("maya", "bartender", "pin");
  const r = await staff("POST", `/orders/${orderId}/accept`, {});
  expect(r.statusCode, r.body).toBe(200);
};
const jobOf = async (orderId: string) =>
  (
    await raw.query<{ id: string; station: string }>(
      "select id, station from print_jobs where order_id = $1 order by created_at, reprint_n",
      [orderId],
    )
  ).rows;
const settleAll = () =>
  raw.query(
    "update print_jobs set status = 'printed', confirmed_at = now() where status in ('queued', 'sent')",
  );

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
  beers.variantId = ids["menu_bud_regular"]!;
  beers.itemId = ids["menu_bud"]!;
  const one = async (sql: string, params: unknown[]) =>
    (await raw.query<{ id: string }>(sql, params)).rows[0]!.id;
  const cat = await one(
    "insert into menu_categories (venue_id, name, sort, tax_category) values ($1, 'TEST Wings', 900, 'food') returning id",
    [venueId],
  );
  food["wingsItem"] = await one(
    "insert into menu_items (venue_id, category_id, name, station) values ($1, $2, 'TEST wings', 'kitchen') returning id",
    [venueId, cat],
  );
  food["wings"] = await one(
    "insert into menu_variants (venue_id, item_id, name, price_cents) values ($1, $2, 'Regular', 1200) returning id",
    [venueId, food["wingsItem"]],
  );
  food["sideItem"] = await one(
    "insert into menu_items (venue_id, category_id, name, station) values ($1, $2, 'TEST side', 'kitchen') returning id",
    [venueId, cat],
  );
  food["side"] = await one(
    "insert into menu_variants (venue_id, item_id, name, price_cents) values ($1, $2, 'Regular', 500) returning id",
    [venueId, food["sideItem"]],
  );
  await raw.query(
    "update venue_modules set allowed = true, state = 'on' where venue_id = $1 and module_id = 'kitchen'",
    [venueId],
  );
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [async (r) => (r.url.startsWith("/v1/venues/") ? who : undefined)],
    moduleCacheMs: 0,
  });
  await app.ready();
  who = as("abhishek", "owner", "passkey");
  const add = async (name: string, station: string) => {
    const r = await staff("POST", "/printers", { name, station, protocol: "cloudprnt" });
    expect(r.statusCode, r.body).toBe(201);
    return r.json() as Printer;
  };
  bar = await add("TEST bar printer", "bar");
  kitchen = await add("TEST kitchen printer", "kitchen");
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await raw.end();
  await db.drop();
});

describe("kitchen tickets (K-03)", () => {
  it("refuses a USB printer for the kitchen, at the route and in the database", async () => {
    who = as("abhishek", "owner", "passkey");
    const r = await staff("POST", "/printers", {
      name: "TEST USB",
      station: "kitchen",
      protocol: "usb",
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/network printer/);
    await expect(
      raw.query(
        "insert into devices (venue_id, kind, name, station, protocol) values ($1, 'printer', 'TEST USB', 'kitchen', 'usb')",
        [venueId],
      ),
    ).rejects.toThrow(/devices_kitchen_network_printer_check/);
  });

  it("a mixed basket prints one bar ticket and one kitchen ticket: notes, the allergy boxed and bold, no prices", async () => {
    await settleAll();
    const [drinks, meal] = await basket([beers, wings("no peanuts", true), side("extra crispy")]);
    await accept(drinks!);
    await accept(meal!);
    expect((await jobOf(drinks!)).map((j) => j.station)).toEqual(["bar"]);
    expect((await jobOf(meal!)).map((j) => j.station)).toEqual(["kitchen"]);

    const k = await poll(kitchen);
    expect(k?.id).toBe((await jobOf(meal!))[0]!.id);
    expect(k!.media[0]).toBe("text/vnd.star.markup");
    expect(k!.contentType).toMatch(/text\/vnd\.star\.markup/);
    expect(k!.text.split("\n")[0]).toBe("[bold: on]KITCHEN[bold: off]");
    expect(k!.text).toContain("ROOM 5");
    expect(k!.text).toContain("Accepted by Maya S.");
    expect(k!.text).toContain("1 x TEST wings");
    expect(k!.text).toContain("TEST fries");
    expect(k!.text).toContain("[bold: on]* ALLERGY: NO PEANUTS");
    expect(k!.text).toContain('"extra crispy"');
    expect(k!.text).not.toMatch(/\$|Bud Light|ID (OK|CHECK)/);
    // A printer that asks for plain text gets the same ticket without the markup.
    const plain = await poll(kitchen, "text/plain");
    expect(plain!.contentType).toMatch(/text\/plain/);
    expect(plain!.text).toContain("* ALLERGY: NO PEANUTS");
    expect(plain!.text).not.toContain("[bold");
    await confirm(kitchen, k!.id);
    expect(await poll(kitchen)).toBeNull();

    const b = await poll(bar);
    expect(b!.text).toContain("2 x Bud Light");
    expect(b!.text).not.toContain("TEST wings");
    await confirm(bar, b!.id);
  });

  it("a kitchen job unconfirmed after three polls is failed, listed for the bar and pushed to the manager on duty", async () => {
    await settleAll();
    const [meal] = await basket([wings(null, false)]);
    await accept(meal!);
    const job = (await jobOf(meal!))[0]!.id;
    clock.set(clock.now().add({ seconds: 16 }));
    expect(await sweepPrintJobs(pool, clock.now())).toBeGreaterThanOrEqual(1);

    who = as("maya", "bartender", "pin");
    const failed = (await staff("GET", "/print-jobs?status=failed")).json().jobs as {
      id: string;
      kitchen: boolean;
      station: string;
    }[];
    expect(failed.find((j) => j.id === job)).toMatchObject({ kitchen: true, station: "kitchen" });
    const event = await raw.query<{ n: number }>(
      "select count(*)::int as n from venue_events where type = 'print_job.failed' and entity_id = $1",
      [job],
    );
    expect(event.rows[0]!.n).toBe(1);
    const push = await raw.query<{ user_id: string; room: string }>(
      `select payload->'audience'->>'user_id' as user_id, payload->'message'->'params'->>'room' as room
         from jobs where kind = 'push.send' and payload->'message'->>'key' = 'kitchen.push.ticketFailed'
          and dedupe_key = $1`,
      [`kitchen-ticket:${job}`],
    );
    expect(push.rows).toHaveLength(1);
    expect(push.rows[0]!.room).toBe("Room 5");
    expect(push.rows[0]!.user_id).toBeTruthy();
    // The board's alert names it a kitchen ticket.
    const board = (await staff("GET", "/board")).json() as {
      alerts?: { kind: string; job_id?: string; kitchen?: boolean }[];
    };
    const alert = board.alerts?.find((a) => a.kind === "ticket" && a.job_id === job);
    expect(alert?.kitchen).toBe(true);
  });

  it("Print at the bar instead prints the same ticket on the bar printer as REPRINT 2; Reprint at the kitchen is REPRINT 3; neither touches the check", async () => {
    const failed = (await staff("GET", "/print-jobs?status=failed")).json().jobs as {
      id: string;
    }[];
    const job = failed[failed.length - 1]!.id;
    const before = await raw.query<{ n: number; cents: number; sent: number }>(
      `select count(*)::int as n, coalesce(sum(qty * unit_cents), 0)::int as cents,
              count(kitchen_sent_at)::int as sent
         from order_items where venue_id = $1 and order_id in (select order_id from print_jobs where id = $2)`,
      [venueId, job],
    );
    const lines = await raw.query<{ n: number }>(
      "select count(*)::int as n from check_lines where check_id = $1",
      [ids["chk_room5"]],
    );

    who = as("maya", "bartender", "pin");
    const atBar = await staff("POST", `/print-jobs/${job}/reprint`, { at: "bar" });
    expect(atBar.statusCode, atBar.body).toBe(201);
    expect(atBar.json()).toMatchObject({ reprint_n: 2 });
    expect(await poll(kitchen)).toBeNull();
    const b = await poll(bar, "text/plain");
    expect(b?.id).toBe(atBar.json().job_id);
    expect(b!.text.split("\n").slice(0, 2)).toEqual(["REPRINT 2", "KITCHEN"]);
    expect(b!.text).toContain("1 x TEST wings");
    await confirm(bar, b!.id);

    const again = await staff("POST", `/print-jobs/${atBar.json().job_id}/reprint`, {});
    expect(again.json()).toMatchObject({ reprint_n: 3 });
    const k = await poll(kitchen, "text/plain");
    expect(k?.id).toBe(again.json().job_id);
    expect(k!.text.split("\n")[0]).toBe("REPRINT 3");
    await confirm(kitchen, k!.id);

    const after = await raw.query<{ n: number; cents: number; sent: number }>(
      `select count(*)::int as n, coalesce(sum(qty * unit_cents), 0)::int as cents,
              count(kitchen_sent_at)::int as sent
         from order_items where venue_id = $1 and order_id in (select order_id from print_jobs where id = $2)`,
      [venueId, job],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    const linesAfter = await raw.query<{ n: number }>(
      "select count(*)::int as n from check_lines where check_id = $1",
      [ids["chk_room5"]],
    );
    expect(linesAfter.rows[0]!.n).toBe(lines.rows[0]!.n);
  });

  it("a replayed food order prints AFTER OUTAGE when it's accepted; with the setting off it doesn't", async () => {
    await settleAll();
    const [meal] = await basket([wings(null, false)], "offline");
    await raw.query("update orders set status = 'held', held_at = now() where id = $1", [meal]);
    await accept(meal!);
    const k = await poll(kitchen, "text/plain");
    expect(k!.text.split("\n").slice(0, 2)).toEqual(["KITCHEN", "AFTER OUTAGE"]);
    expect(k!.text.replace(/\n/g, " ")).toContain("check with the kitchen before making");
    await confirm(kitchen, k!.id);

    // A guest's food order never says it.
    const [live] = await basket([side(null)]);
    await accept(live!);
    const g = await poll(kitchen, "text/plain");
    expect(g!.text).not.toContain("AFTER OUTAGE");
    await confirm(kitchen, g!.id);
  });
});
