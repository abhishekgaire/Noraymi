import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack, seedHostToken } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { executors } from "../approvals/service.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/**
 * Modular menu choices (K-12; Kitchen and food · Meals, combos and sauces). A TEST menu, test prices,
 * built through Admin → Menu's routes over the demo seed: a TEST burger with an optional "Make it a
 * meal" (+$5.00) that opens a side and a drink, both other menu items (components); a TEST combo
 * whose soda is on one size only; TEST tenders with one sauce included and each extra $0.75. The
 * money matches the menu_choices money cases; components print under their line in the kitchen and
 * a meal's soda prints at the bar.
 */
let db: TestDatabase;
let owner: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
let who: Principal | undefined;
let host = "";
let n = 0;
const m: Record<string, string> = {};
const clock = new SimulatedClock(SEED_NOW);
const as = (slug: string, role: string, session: "passkey" | "pin" = "passkey") => {
  who = {
    kind: "user",
    userId: ids[slug]!,
    session,
    memberships: [{ venueId, membershipId: ids[`${slug}.membership`]!, role } as never],
  };
};
const call = (method: "GET" | "POST" | "PATCH", path: string, payload?: object, key?: string) =>
  api.inject({
    method,
    url: `/v1/venues/${venueId}${path}`,
    ...(payload ? { payload } : {}),
    ...(key ? { headers: { "idempotency-key": key } } : {}),
  });
const save = async (path: string, body: object) => {
  const r = await call("POST", `/menu/${path}`, body, `k12-${++n}`);
  expect(r.statusCode, r.body).toBe(201);
  return (r.json() as { id: string }).id;
};
const guest = (method: "GET" | "POST", url: string, payload?: object) =>
  api.inject({ method, url, headers: { cookie: host }, ...(payload ? { payload } : {}) });
interface ViewLine {
  id: number;
  kind: string;
  description: string;
  amount_cents: number;
  tax_category?: string | null;
  kitchen?: { sent_at: string | null; open_qty: number } | null;
  part_of?: number;
}
const linesOf = async (check: string) => {
  const r = await call("GET", `/checks/${check}`);
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as { lines: ViewLine[] }).lines;
};
const jobs = async (check: string) =>
  (
    await owner.query<{ station: string; payload: { lines: unknown[] } }>(
      `select j.station, j.payload from print_jobs j left join orders o on o.id = j.order_id
        where coalesce(j.check_id, o.check_id) = $1 order by j.created_at, j.station`,
      [check],
    )
  ).rows;

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
  await owner.query(
    "update venue_modules set allowed = true, state = 'on' where venue_id = $1 and module_id = 'kitchen'",
    [venueId],
  );
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    moduleCacheMs: 0,
    authenticators: [async (r) => (r.url.startsWith("/v1/venues/") ? who : undefined)],
  });
  await api.ready();
  host = String(
    (
      await api.inject({
        method: "POST",
        url: "/v1/public/room-session/host",
        payload: { token: seedHostToken("sess_room9") },
      })
    ).headers["set-cookie"],
  ).split(";")[0]!;

  // The TEST menu, through Admin → Menu as the owner.
  as("abhishek", "owner");
  const food = await save("categories", { name: "TEST Food", tax_category: "food", sort: 900 });
  const drinks = await save("categories", { name: "TEST Sodas", tax_category: "drink", sort: 910 });
  const item = async (
    cat: string,
    name: string,
    station: "bar" | "kitchen",
    sizes: [string, number][],
  ) => {
    const id = await save("items", { category_id: cat, name, station });
    m[name] = id;
    for (const [size, price] of sizes)
      m[`${name}/${size}`] = await save("variants", {
        item_id: id,
        name: size,
        price_cents: price,
      });
    return id;
  };
  await item(food, "TEST Fries", "kitchen", [["Regular", 545]]);
  await item(food, "TEST Rings", "kitchen", [["Regular", 545]]);
  await item(drinks, "TEST Coke", "bar", [["Regular", 310]]);
  const burger = await item(food, "TEST Burger", "kitchen", [["Regular", 995]]);
  const meal = await save("modifier-groups", {
    item_id: burger,
    name: "Make it a meal",
    min_choices: 0,
    max_choices: 1,
  });
  m["meal"] = await save("options", {
    group_id: meal,
    name: "Add fries + drink",
    price_delta_cents: 500,
  });
  const side = await save("modifier-groups", {
    item_id: burger,
    name: "Meal side",
    required: true,
    min_choices: 1,
    max_choices: 1,
    when_option_id: m["meal"],
  });
  m["burger/fries"] = await save("options", {
    group_id: side,
    name: "TEST Fries",
    component_variant_id: m["TEST Fries/Regular"],
  });
  m["burger/rings"] = await save("options", {
    group_id: side,
    name: "TEST Rings",
    price_delta_cents: 100,
    component_variant_id: m["TEST Rings/Regular"],
  });
  const drink = await save("modifier-groups", {
    item_id: burger,
    name: "Meal drink",
    required: true,
    min_choices: 1,
    max_choices: 1,
    when_option_id: m["meal"],
  });
  m["burger/coke"] = await save("options", {
    group_id: drink,
    name: "TEST Coke",
    component_variant_id: m["TEST Coke/Regular"],
  });
  const combo = await item(food, "TEST Combo", "kitchen", [
    ["+ 1 Side", 1099],
    ["+ 1 Side + 1 Soda", 1349],
  ]);
  const comboSide = await save("modifier-groups", {
    item_id: combo,
    name: "Side",
    required: true,
    min_choices: 1,
    max_choices: 1,
  });
  m["combo/fries"] = await save("options", {
    group_id: comboSide,
    name: "TEST Fries",
    component_variant_id: m["TEST Fries/Regular"],
  });
  const soda = await save("modifier-groups", {
    item_id: combo,
    name: "Soda",
    required: true,
    min_choices: 1,
    max_choices: 1,
    variant_ids: [m["TEST Combo/+ 1 Side + 1 Soda"]],
  });
  m["combo/coke"] = await save("options", {
    group_id: soda,
    name: "TEST Coke",
    component_variant_id: m["TEST Coke/Regular"],
  });
  const tenders = await item(food, "TEST Tenders", "kitchen", [["3 PC", 999]]);
  const sauce = await save("modifier-groups", {
    item_id: tenders,
    name: "Sauce",
    required: true,
    min_choices: 1,
    max_choices: 3,
    included_choices: 1,
    extra_choice_cents: 75,
  });
  for (const s of ["Ranch", "BBQ", "Sweet Chili"])
    m[`sauce/${s}`] = await save("options", { group_id: sauce, name: s });
});

afterAll(async () => {
  await api.close();
  await owner.end();
  await db.drop();
});

describe("Admin → Menu's choice settings (K-12)", () => {
  it("the menu tree carries them, with each component's item", async () => {
    const r = await call("GET", "/menu");
    expect(r.statusCode, r.body).toBe(200);
    const items = (
      r.json() as { categories: { items: { id: string; groups: never[] }[] }[] }
    ).categories.flatMap((c) => c.items);
    const burger = items.find((i) => i.id === m["TEST Burger"]) as unknown as {
      groups: {
        name: string;
        when_option_id: string | null;
        options: { id: string; component: { name: string; station: string } | null }[];
      }[];
    };
    expect(burger.groups.map((g) => [g.name, g.when_option_id])).toEqual([
      ["Make it a meal", null],
      ["Meal drink", m["meal"]],
      ["Meal side", m["meal"]],
    ]);
    expect(burger.groups[1]!.options[0]!.component).toMatchObject({
      name: "TEST Coke",
      station: "bar",
      tax_category: "drink",
      price_cents: 310,
    });
    const tenders = items.find((i) => i.id === m["TEST Tenders"]) as unknown as {
      groups: { included_choices: number; extra_choice_cents: number }[];
    };
    expect(tenders.groups[0]).toMatchObject({ included_choices: 1, extra_choice_cents: 75 });
  });

  it("refuses a size of another item, an opening choice of the same group, and a component that's itself", async () => {
    as("abhishek", "owner");
    const other = await call(
      "POST",
      "/menu/modifier-groups",
      { item_id: m["TEST Burger"], name: "Bad", variant_ids: [m["TEST Combo/+ 1 Side"]] },
      `k12-${++n}`,
    );
    expect(other.statusCode).toBe(400);
    expect(other.json().error.details.reason).toBe("not_this_items_size");
    const groups = await call("GET", `/menu/modifier-groups?item_id=${m["TEST Burger"]}`);
    const mealGroup = (groups.json().items as { id: string; name: string }[]).find(
      (g) => g.name === "Make it a meal",
    )!;
    const self = await call(
      "PATCH",
      `/menu/modifier-groups/${mealGroup.id}`,
      { when_option_id: m["meal"] },
      `k12-${++n}`,
    );
    expect(self.statusCode).toBe(400);
    expect(self.json().error.details.reason).toBe("bad_opening_choice");
    const itself = await call(
      "POST",
      "/menu/options",
      { group_id: mealGroup.id, name: "Bad", component_variant_id: m["TEST Burger/Regular"] },
      `k12-${++n}`,
    );
    expect(itself.statusCode).toBe(400);
    expect(itself.json().error.details.reason).toBe("component_is_itself");
  });

  it("a bartender can't change them", async () => {
    as("maya", "bartender", "pin");
    const r = await call(
      "POST",
      "/menu/modifier-groups",
      { item_id: m["TEST Burger"], name: "Nope" },
      `k12-${++n}`,
    );
    expect(r.statusCode).toBe(403);
  });
});

describe("a +$5.00 meal, a combo and sauces on Room 9 (K-12)", () => {
  it("a meal rung on the room: the burger, its fries and its Coke as three lines, $5.00 divided", async () => {
    as("maya", "bartender", "pin");
    const room = ids["chk_room9"]!;
    const before = (await linesOf(room)).length;
    const r = await call("POST", `/checks/${room}/orders`, {
      client_order_id: `k12-meal-${++n}`,
      lines: [
        {
          variant_id: m["TEST Burger/Regular"],
          qty: 1,
          option_ids: [m["burger/coke"], m["meal"], m["burger/fries"]],
          kitchen_note: "TEST no onion",
        },
      ],
    });
    expect(r.statusCode, r.body).toBe(201);
    const added = (await linesOf(room)).slice(before);
    expect(added.map((l) => [l.description, l.amount_cents])).toEqual([
      ["TEST Burger · TEST Coke", 181],
      ["TEST Burger · Add fries + drink", 995],
      ["TEST Burger · TEST Fries", 319],
    ]);
    // The Coke prints at the bar at once, named for its burger; the food waits as Not sent.
    const bar = (await jobs(room)).filter((j) => j.station === "bar").at(-1)!;
    expect(bar.payload.lines).toEqual([
      { qty: 1, name: "TEST Coke", options: ["with TEST Burger"], notes: null },
    ]);
    const unsent = added.filter((l) => l.kitchen && !l.kitchen.sent_at);
    expect(unsent.map((l) => l.description)).toEqual([
      "TEST Burger · Add fries + drink",
      "TEST Burger · TEST Fries",
    ]);
    // Send to kitchen with the burger alone: its fries go with it, under it.
    const sent = await call(
      "POST",
      `/checks/${room}/kitchen-sends`,
      { lines: [{ line_id: unsent[0]!.id }] },
      `k12-send-${++n}`,
    );
    expect(sent.statusCode, sent.body).toBe(201);
    expect(sent.json().line_ids).toEqual([unsent[0]!.id, unsent[1]!.id]);
    const kitchen = (await jobs(room)).filter((j) => j.station === "kitchen").at(-1)!;
    expect(kitchen.payload.lines).toEqual([
      {
        qty: 1,
        name: "TEST Burger",
        options: ["Add fries + drink", "+ TEST Fries"],
        notes: null,
        kitchen_note: "TEST no onion",
        allergy: false,
      },
    ]);
    const after = (await linesOf(room)).slice(before);
    expect(after.filter((l) => l.kitchen && !l.kitchen.sent_at)).toEqual([]);
  });

  it("a guest's combo: the soda on its size only, the side under the combo on the kitchen ticket at Accept", async () => {
    const wrong = await guest("POST", "/v1/public/room-session/orders", {
      client_order_id: `k12-guest-${++n}-abcdef`,
      lines: [
        {
          variant_id: m["TEST Combo/+ 1 Side"],
          qty: 1,
          option_ids: [m["combo/fries"], m["combo/coke"]],
        },
      ],
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.details.reason).toBe("not_this_size");
    const r = await guest("POST", "/v1/public/room-session/orders", {
      client_order_id: `k12-guest-${++n}-abcdef`,
      lines: [
        {
          variant_id: m["TEST Combo/+ 1 Side + 1 Soda"],
          qty: 2,
          option_ids: [m["combo/fries"], m["combo/coke"]],
        },
      ],
    });
    expect(r.statusCode, r.body).toBe(201);
    const placed = r.json().orders as { id: string; station: string }[];
    expect(placed.map((o) => o.station)).toEqual(["bar", "kitchen"]);
    as("maya", "bartender", "pin");
    for (const o of placed) {
      const a = await call("POST", `/orders/${o.id}/accept`, {});
      expect(a.statusCode, a.body).toBe(200);
    }
    const ticket = await owner.query<{ payload: { lines: unknown[] } }>(
      "select payload from print_jobs where order_id = $1",
      [placed[1]!.id],
    );
    expect(ticket.rows[0]!.payload.lines).toEqual([
      {
        qty: 2,
        name: "TEST Combo · + 1 Side + 1 Soda",
        options: ["+ TEST Fries"],
        notes: null,
        kitchen_note: null,
        allergy: false,
      },
    ]);
    const lines = (await linesOf(ids["chk_room9"]!)).slice(-3);
    expect(lines.map((l) => [l.description, l.amount_cents])).toEqual([
      ["TEST Combo · + 1 Side + 1 Soda · TEST Coke", 0],
      ["TEST Combo · + 1 Side + 1 Soda", 2698],
      ["TEST Combo · + 1 Side + 1 Soda · TEST Fries", 0],
    ]);
  });

  it("three sauces with one included: two extras at $0.75; a meal with no side is refused", async () => {
    as("maya", "bartender", "pin");
    const room = ids["chk_room9"]!;
    const missing = await call("POST", `/checks/${room}/orders`, {
      client_order_id: `k12-bad-${++n}`,
      lines: [
        { variant_id: m["TEST Burger/Regular"], qty: 1, option_ids: [m["meal"], m["burger/coke"]] },
      ],
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.details).toMatchObject({
      reason: "choice_missing",
      group: "Meal side",
    });
    const r = await call("POST", `/checks/${room}/orders`, {
      client_order_id: `k12-sauce-${++n}`,
      lines: [
        {
          variant_id: m["TEST Tenders/3 PC"],
          qty: 1,
          option_ids: [m["sauce/Sweet Chili"], m["sauce/Ranch"], m["sauce/BBQ"]],
        },
      ],
    });
    expect(r.statusCode, r.body).toBe(201);
    const last = (await linesOf(room)).at(-1)!;
    expect([last.description, last.amount_cents]).toEqual([
      "TEST Tenders · BBQ, Ranch, Sweet Chili",
      1149,
    ]);
  });
});

describe("voiding a meal takes its parts with it (K-12; Money rules 7)", () => {
  // Rings `qty` TEST meals (burger, fries, Coke) on Room 9 and answers their three lines.
  const ringMeals = async (qty: number) => {
    as("maya", "bartender", "pin");
    const room = ids["chk_room9"]!;
    const before = (await linesOf(room)).length;
    const r = await call("POST", `/checks/${room}/orders`, {
      client_order_id: `k12-void-${++n}`,
      lines: [
        {
          variant_id: m["TEST Burger/Regular"],
          qty,
          option_ids: [m["meal"], m["burger/fries"], m["burger/coke"]],
        },
      ],
    });
    expect(r.statusCode, r.body).toBe(201);
    const added = (await linesOf(room)).slice(before);
    const find = (end: string) => added.find((l) => l.description.endsWith(end))!;
    return {
      room,
      burger: find("Add fries + drink"),
      fries: find("TEST Fries"),
      coke: find("TEST Coke"),
    };
  };
  const reversals = async (lineIds: number[]) =>
    (
      await owner.query<{
        id: string;
        reverses_id: string;
        kind: string;
        qty: string;
        amount_cents: string;
        part_of_id: string | null;
        reason: string;
      }>(
        `select id, reverses_id, kind, qty, amount_cents, part_of_id, reason from check_lines
          where reverses_id = any($1::bigint[]) order by id`,
        [lineIds],
      )
    ).rows;

  it("a reason-only void of the burger voids its fries and Coke too: one action, $14.95 back", async () => {
    const meal = await ringMeals(1);
    // The check names each part's line, so the fix panel can say what comes off with it.
    expect([meal.fries.part_of, meal.coke.part_of, meal.burger.part_of]).toEqual([
      meal.burger.id,
      meal.burger.id,
      undefined,
    ]);
    const r = await call(
      "POST",
      `/checks/${meal.room}/lines/${meal.burger.id}/void`,
      { reason: "TEST wrong table", made: false },
      `k12-void-${++n}`,
    );
    expect(r.statusCode, r.body).toBe(201);
    const back = await reversals([meal.burger.id, meal.fries.id, meal.coke.id]);
    expect(back.map((x) => [Number(x.reverses_id), x.kind, Number(x.amount_cents)])).toEqual([
      [meal.burger.id, "void", -995],
      [meal.coke.id, "void", -181],
      [meal.fries.id, "void", -319],
    ]);
    const head = back[0]!;
    expect(head.part_of_id).toBeNull();
    expect(back.slice(1).map((x) => x.part_of_id)).toEqual([head.id, head.id]);
    expect(back.every((x) => x.reason === "TEST wrong table")).toBe(true);

    // The exceptions report shows one entry, at the whole amount, naming the parts.
    as("abhishek", "owner");
    const report = await call("GET", "/reports/exceptions?date=2026-09-25");
    expect(report.statusCode, report.body).toBe(200);
    const mine = (
      report.json() as { exceptions: { what: string; why: string; amount_cents: number }[] }
    ).exceptions.filter((x) => x.why === "TEST wrong table");
    expect(mine.map((x) => [x.what, x.amount_cents])).toEqual([
      ["VOID · TEST Burger · Add fries + drink + TEST Coke + TEST Fries", 1495],
    ]);
  });

  it("a part voided alone stays allowed, and isn't voided twice with its burger", async () => {
    const meal = await ringMeals(1);
    const alone = await call(
      "POST",
      `/checks/${meal.room}/lines/${meal.coke.id}/void`,
      { reason: "TEST spilled", made: true },
      `k12-void-${++n}`,
    );
    expect(alone.statusCode, alone.body).toBe(201);
    const r = await call(
      "POST",
      `/checks/${meal.room}/lines/${meal.burger.id}/comp`,
      { reason: "TEST took too long", made: true },
      `k12-void-${++n}`,
    );
    expect(r.statusCode, r.body).toBe(201);
    const back = await reversals([meal.burger.id, meal.fries.id, meal.coke.id]);
    expect(back.map((x) => [Number(x.reverses_id), x.kind, Number(x.amount_cents)])).toEqual([
      [meal.coke.id, "void", -181],
      [meal.burger.id, "comp", -995],
      [meal.fries.id, "comp", -319],
    ]);
  });

  it("over the limit, one approval for the whole meal names its parts, and approving writes them all", async () => {
    const meal = await ringMeals(2);
    // 2 x $14.95 = $29.90, over the $25.00 reason-only limit.
    const r = await call(
      "POST",
      `/checks/${meal.room}/lines/${meal.burger.id}/void`,
      { reason: "TEST over limit", made: false },
      `k12-void-${++n}`,
    );
    expect(r.statusCode, r.body).toBe(202);
    const asked = (
      await owner.query(
        "select * from approvals where reason = 'TEST over limit' and status = 'pending'",
      )
    ).rows;
    expect(asked).toHaveLength(1);
    expect(Number(asked[0].amount_cents)).toBe(2990);
    expect(asked[0].payload.description).toBe(
      "TEST Burger · Add fries + drink + TEST Coke + TEST Fries",
    );
    expect(await reversals([meal.burger.id])).toEqual([]);
    // The approver's phone runs the void (approvals.int.test.ts covers the phone itself).
    await executors.get("void")!(owner, venueId, asked[0], {
      approverId: ids["andy"]!,
      at: clock.now(),
    });
    const back = await reversals([meal.burger.id, meal.fries.id, meal.coke.id]);
    expect(back.map((x) => [Number(x.qty), Number(x.amount_cents)])).toEqual([
      [2, -1990],
      [2, -362],
      [2, -638],
    ]);
  });

  it("Remove on a meal that's Not sent takes its fries and Coke off with it", async () => {
    const meal = await ringMeals(1);
    const r = await call(
      "POST",
      `/checks/${meal.room}/lines/${meal.burger.id}/remove-unsent`,
      undefined,
      `k12-void-${++n}`,
    );
    expect(r.statusCode, r.body).toBe(200);
    const back = await reversals([meal.burger.id, meal.fries.id, meal.coke.id]);
    expect(back.map((x) => [Number(x.reverses_id), Number(x.amount_cents), x.reason])).toEqual([
      [meal.burger.id, -995, "Not sent to the kitchen"],
      [meal.coke.id, -181, "Not sent to the kitchen"],
      [meal.fries.id, -319, "Not sent to the kitchen"],
    ]);
  });
});
