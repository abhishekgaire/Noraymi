import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack, seedHostToken } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/**
 * P-17 · Kitchen screen on the demo seed. Off by default and refused while off; once on, a guest's
 * food shows at Accept and staff-rung food at Send to kitchen, oldest first, with the printer still
 * printing; Done bumps it once (from the kitchen display or a bar computer) and the bar reads it
 * under tonight's done; with `kitchenScreen.print` off nothing goes to the printer. West 4 has no
 * kitchen, so a test-only menu item marked TEST is laid over the seed.
 */
let db: TestDatabase;
let owner: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
let who: Principal | undefined;
let display: string;
let fries: string;
let n = 0;
const clock = new SimulatedClock(SEED_NOW);

const maya = () => {
  who = {
    kind: "user",
    userId: ids["maya"]!,
    session: "pin",
    memberships: [{ venueId, membershipId: ids["maya.membership"]!, role: "bartender" }],
  };
};
const kitchenDisplay = () => {
  who = { kind: "device", deviceId: display, venueId, deviceKind: "kitchen_display" };
};
const call = (method: "GET" | "POST", path: string, payload?: object, key?: string) =>
  api.inject({
    method,
    url: `/v1/venues/${venueId}${path}`,
    ...(payload ? { payload } : {}),
    ...(key ? { headers: { "idempotency-key": key } } : {}),
  });
const module = (state: "on" | "off") =>
  owner.query(
    `insert into venue_modules (venue_id, module_id, allowed, state) values ($1, 'kitchen_screen', true, $2)
     on conflict (venue_id, module_id) do update set state = $2, allowed = true`,
    [venueId, state],
  );
const open = async () => {
  const r = await call("GET", "/kitchen/tickets");
  expect(r.statusCode, r.body).toBe(200);
  return r.json().tickets as {
    id: string;
    room: string | null;
    lines: { name: string; kitchen_note: string | null; allergy: boolean }[];
  }[];
};
const guestFries = async () => {
  const host = String(
    (
      await api.inject({
        method: "POST",
        url: "/v1/public/room-session/host",
        payload: { token: seedHostToken("sess_room9") },
      })
    ).headers["set-cookie"],
  ).split(";")[0]!;
  const placed = await api.inject({
    method: "POST",
    url: "/v1/public/room-session/orders",
    headers: { cookie: host },
    payload: {
      client_order_id: `kitchen-screen-${++n}-abcdef`,
      lines: [{ variant_id: fries, qty: 2 }],
    },
  });
  expect(placed.statusCode, placed.body).toBe(201);
  const order = (placed.json().orders as { id: string }[])[0]!.id;
  maya();
  expect((await call("POST", `/orders/${order}/accept`, {})).statusCode).toBe(200);
  return order;
};
const kitchenJobs = async () =>
  Number(
    (
      await owner.query<{ n: string }>(
        "select count(*) as n from print_jobs where venue_id = $1 and station = 'kitchen'",
        [venueId],
      )
    ).rows[0]!.n,
  );

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
  const one = async (sql: string, params: unknown[]) =>
    (await owner.query<{ id: string }>(sql, params)).rows[0]!.id;
  const cat = await one(
    "insert into menu_categories (venue_id, name, sort, tax_category) values ($1, 'TEST Sides', 910, 'food') returning id",
    [venueId],
  );
  const item = await one(
    "insert into menu_items (venue_id, category_id, name, station) values ($1, $2, 'TEST French Fries', 'kitchen') returning id",
    [venueId, cat],
  );
  fries = await one(
    "insert into menu_variants (venue_id, item_id, name, price_cents) values ($1, $2, 'Regular', 500) returning id",
    [venueId, item],
  );
  display = await one(
    "insert into devices (venue_id, kind, name) values ($1, 'kitchen_display', 'TEST kitchen screen') returning id",
    [venueId],
  );
  await owner.query(
    "update venue_modules set allowed = true, state = 'on' where venue_id = $1 and module_id = 'kitchen'",
    [venueId],
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
  await owner.end();
  await db.drop();
});

describe("Kitchen screen (P-17)", () => {
  it("is off by default: its routes answer module_off and a kitchen ticket only prints", async () => {
    kitchenDisplay();
    const r = await call("GET", "/kitchen/tickets");
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe("module_off");
    const before = await kitchenJobs();
    await guestFries();
    expect(await kitchenJobs()).toBe(before + 1);
    expect(
      (await owner.query("select 1 from kitchen_tickets where venue_id = $1", [venueId])).rowCount,
    ).toBe(0);
  });

  it("on, a guest's food shows at Accept with the printer still printing, and staff-rung food at Send to kitchen, oldest first", async () => {
    await module("on");
    const before = await kitchenJobs();
    await guestFries();
    expect(await kitchenJobs()).toBe(before + 1);
    kitchenDisplay();
    const first = await open();
    expect(first).toHaveLength(1);
    expect(first[0]!.room).toBe("Room 9");
    expect(first[0]!.lines[0]!.name).toContain("TEST French Fries");

    // Staff-rung food on Jess P.'s tab: nothing until Send to kitchen, then a second ticket.
    maya();
    const tab = ids["chk_t1"]!;
    const rung = await call("POST", `/checks/${tab}/orders`, {
      client_order_id: `kitchen-screen-${++n}`,
      lines: [{ variant_id: fries, qty: 1 }],
    });
    expect(rung.statusCode, rung.body).toBe(201);
    kitchenDisplay();
    expect(await open()).toHaveLength(1);
    maya();
    const view = (await call("GET", `/checks/${tab}`)).json() as {
      lines: { id: number; kitchen?: { sent_at: string | null } }[];
    };
    const line = view.lines.find((l) => l.kitchen && !l.kitchen.sent_at)!;
    const sent = await call(
      "POST",
      `/checks/${tab}/kitchen-sends`,
      { lines: [{ line_id: line.id, kitchen_note: "peanuts", kitchen_note_allergy: true }] },
      `ks-${++n}`,
    );
    expect(sent.statusCode, sent.body).toBe(201);
    kitchenDisplay();
    const both = await open();
    expect(both.map((k) => k.room)).toEqual(["Room 9", "Bar · Jess P."]);
    expect(both[1]!.lines[0]).toMatchObject({ kitchen_note: "peanuts", allergy: true });
  });

  it("Done bumps a ticket once and the bar reads it under tonight's done", async () => {
    kitchenDisplay();
    const [first] = await open();
    const done = await call("POST", `/kitchen/tickets/${first!.id}/done`);
    expect(done.statusCode, done.body).toBe(200);
    const doneAt = done.json().ticket.done_at as string;
    clock.advance({ minutes: 1 });
    const again = await call("POST", `/kitchen/tickets/${first!.id}/done`);
    expect(again.json().ticket.done_at).toBe(doneAt);
    expect((await open()).map((k) => k.id)).not.toContain(first!.id);
    const row = await owner.query<{ done_device_id: string }>(
      "select done_device_id from kitchen_tickets where id = $1",
      [first!.id],
    );
    expect(row.rows[0]!.done_device_id).toBe(display);
    const told = await owner.query(
      "select 1 from venue_events where venue_id = $1 and type = 'kitchen.ticket_done' and entity_id = $2",
      [venueId, first!.id],
    );
    expect(told.rowCount).toBe(1);
    maya();
    const bar = await call("GET", "/kitchen/tickets?view=done");
    expect(bar.statusCode).toBe(200);
    expect((bar.json().tickets as { id: string }[]).map((k) => k.id)).toContain(first!.id);
    expect(
      (await call("POST", `/kitchen/tickets/00000000-0000-4000-8000-000000000000/done`)).statusCode,
    ).toBe(404);
  });

  it("with kitchenScreen.print off, a ticket goes to the screen and not the printer", async () => {
    await owner.query(
      `insert into venue_settings (venue_id, key, version, value, starts_on, saved_at, saved_by)
       select $1, 'kitchenScreen', coalesce(max(version), 0) + 1, '{"print": false}', '2026-09-01', now(), $2
         from venue_settings where venue_id = $1 and key = 'kitchenScreen'`,
      [venueId, ids["andy"]],
    );
    const before = await kitchenJobs();
    kitchenDisplay();
    const count = (await open()).length;
    await guestFries();
    expect(await kitchenJobs()).toBe(before);
    kitchenDisplay();
    expect(await open()).toHaveLength(count + 1);
  });

  it("refuses the screen when the module goes off again", async () => {
    await module("off");
    kitchenDisplay();
    expect((await call("GET", "/kitchen/tickets")).statusCode).toBe(404);
  });
});
