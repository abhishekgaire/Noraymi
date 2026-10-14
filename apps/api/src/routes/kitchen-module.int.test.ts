import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import type { RegisteredRoute } from "../http/registry.js";

/**
 * Kitchen & food, the switch and the `kitchen` key (K-01; spec 16 · The Kitchen module). The demo
 * seed is West 4, which has no kitchen: each step lays the test-only kitchen over it (the Console
 * allowing the module, a kitchen printer, a notice marked as a test one). No Sing Sing fact is used.
 */
let db: TestDatabase;
let owner: pg.Pool;
let api: FastifyInstance & { routes: RegisteredRoute[] };
let venueId: string;
let ids: Record<string, string>;
let who: Principal | undefined;
const clock = new SimulatedClock(SEED_NOW);
const as = (slug: string, role: string, session: "passkey" | "pin" = "passkey") => {
  who = {
    kind: "user",
    userId: ids[slug]!,
    session,
    memberships: [{ venueId, membershipId: ids[`${slug}.membership`]!, role } as never],
  };
};
const call = (method: "GET" | "PATCH" | "PUT", path: string, payload?: object) =>
  api.inject({ method, url: `/v1/venues/${venueId}${path}`, ...(payload ? { payload } : {}) });
const kitchenRow = async () =>
  (
    (await call("GET", "/modules")).json() as {
      modules: {
        id: string;
        allowed: boolean;
        state: string;
        still_needs?: string[];
        wanted?: boolean;
      }[];
    }
  ).modules.find((m) => m.id === "kitchen")!;
const stateOf = async (id: string) =>
  (
    await owner.query<{ state: string }>(
      "select state from venue_modules where venue_id = $1 and module_id = $2",
      [venueId, id],
    )
  ).rows[0]!.state;
const TEST_NOTICE = { en: "TEST ONLY · allergy notice", es: "SOLO PRUEBA · aviso de alergias" };

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
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    moduleCacheMs: 0,
    authenticators: [async () => who],
  }) as typeof api;
  await api.ready();
  as("abhishek", "owner");
});

afterAll(async () => {
  await api.close();
  await owner.end();
  await db.drop();
});

describe("Kitchen & food: the module switch and the kitchen key", () => {
  it("West 4's plan has no kitchen: Kitchen & food is a phase 1 module that's off and not allowed", async () => {
    expect(await kitchenRow()).toMatchObject({ allowed: false, state: "off", phase1: true });
    expect((await call("PATCH", "/modules/kitchen", { state: "on" })).statusCode).toBe(403);
  });

  it("every kitchen route answers 404 module_off while the module is off", async () => {
    const kitchenRoutes = api.routes.filter((r) => r.module === "kitchen");
    expect(kitchenRoutes.length).toBeGreaterThan(0);
    for (const r of kitchenRoutes) {
      const res = await api.inject({
        method: r.method as "GET",
        url: r.url.replace(":venueId", venueId),
      });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(404);
      expect(res.json().error.code).toBe("module_off");
    }
  });

  it("unsentWarnMin defaults to 5 and refuses a value outside 1 to 60", async () => {
    const r = await call("GET", "/settings/kitchen");
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().value).toEqual({ allergyNotice: null, lastOrder: null, unsentWarnMin: 5 });
    for (const bad of [0, 61]) {
      const res = await call("PUT", "/settings/kitchen", {
        value: { allergyNotice: null, lastOrder: null, unsentWarnMin: bad },
      });
      expect(res.statusCode, String(bad)).toBe(400);
      expect(res.json().error.message).toContain("kitchen.unsentWarnMin");
    }
    // A bartender can't change it: Admin → Kitchen is the managers' and the owner's.
    as("maya", "bartender", "pin");
    expect((await call("GET", "/settings/kitchen")).statusCode).toBe(403);
    as("abhishek", "owner");
  });

  it("with no kitchen printer or no notice, Kitchen stays off and says what's missing", async () => {
    await owner.query(
      "update venue_modules set allowed = true where venue_id = $1 and module_id = 'kitchen'",
      [venueId],
    );
    expect((await kitchenRow()).still_needs).toEqual(["printer", "allergyNotice"]);
    const both = await call("PATCH", "/modules/kitchen", { state: "on" });
    expect(both.statusCode).toBe(400);
    expect(both.json().error.message).toBe(
      "Kitchen · needs a kitchen printer and the allergy notice",
    );
    expect(await stateOf("kitchen")).toBe("off");

    // The notice, saved in Admin → Kitchen while the module is off.
    const saved = await call("PUT", "/settings/kitchen", {
      value: { allergyNotice: TEST_NOTICE, lastOrder: null, unsentWarnMin: 7 },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await kitchenRow()).still_needs).toEqual(["printer"]);
    expect((await call("PATCH", "/modules/kitchen", { state: "on" })).json().error.message).toBe(
      "Kitchen · needs a kitchen printer",
    );

    // A printer cabled from the kitchen to a bar computer counts (W-03; D127), as a cloud printer does.
    const cabled = await owner.query<{ id: string }>(
      "insert into devices (venue_id, kind, name, station, protocol) values ($1, 'printer', 'TEST kitchen USB', 'kitchen', 'usb') returning id",
      [venueId],
    );
    expect((await kitchenRow()).still_needs).toEqual([]);
    await owner.query("update devices set revoked_at = now() where id = $1", [cabled.rows[0]!.id]);
    expect((await kitchenRow()).still_needs).toEqual(["printer"]);
    await owner.query(
      "insert into devices (venue_id, kind, name, station, protocol) values ($1, 'printer', 'TEST kitchen', 'kitchen', 'cloudprnt')",
      [venueId],
    );
    expect((await kitchenRow()).still_needs).toEqual([]);
    const on = await call("PATCH", "/modules/kitchen", { state: "on" });
    expect(on.statusCode, on.body).toBe(200);
    expect(await stateOf("kitchen")).toBe("on");

    const k = await call("GET", "/kitchen");
    expect(k.statusCode, k.body).toBe(200);
    expect(k.json()).toMatchObject({
      allergy_notice: TEST_NOTICE,
      last_order: null,
      unsent_warn_min: 7,
      kitchen_printer: true,
    });
  });

  it("on once ready (O-17; D129): chosen before its printer and notice, Kitchen turns on by itself once both are in", async () => {
    // Start again from off, with no notice and no kitchen printer.
    expect((await call("PATCH", "/modules/kitchen", { state: "off" })).statusCode).toBe(200);
    await call("PUT", "/settings/kitchen", {
      value: { allergyNotice: null, lastOrder: null, unsentWarnMin: 7 },
    });
    await owner.query(
      "update devices set revoked_at = now() where venue_id = $1 and station = 'kitchen' and revoked_at is null",
      [venueId],
    );
    expect((await kitchenRow()).still_needs).toEqual(["printer", "allergyNotice"]);

    // On is still refused outright; "on once ready" records the choice and leaves it off.
    expect((await call("PATCH", "/modules/kitchen", { state: "on" })).statusCode).toBe(400);
    const wait = await call("PATCH", "/modules/kitchen", { state: "on", when_ready: true });
    expect(wait.statusCode, wait.body).toBe(200);
    expect(wait.json()).toMatchObject({
      applied: false,
      waiting: true,
      still_needs: ["printer", "allergyNotice"],
    });
    expect(await kitchenRow()).toMatchObject({ state: "off", wanted: true });
    // Off forgets it; the owner can choose it again.
    expect((await call("PATCH", "/modules/kitchen", { state: "off" })).json()).toMatchObject({
      applied: true,
    });
    expect(await kitchenRow()).toMatchObject({ state: "off", wanted: false });
    await call("PATCH", "/modules/kitchen", { state: "on", when_ready: true });

    // The notice alone isn't enough: still off and wanted.
    const notice = await call("PUT", "/settings/kitchen", {
      value: { allergyNotice: TEST_NOTICE, lastOrder: null, unsentWarnMin: 7 },
    });
    expect(notice.statusCode, notice.body).toBe(200);
    expect(await kitchenRow()).toMatchObject({
      state: "off",
      wanted: true,
      still_needs: ["printer"],
    });

    // The kitchen printer completes it: Kitchen & food is on, and no longer waiting.
    const printer = await call("POST", "/printers", {
      name: "TEST kitchen 2",
      station: "kitchen",
      protocol: "cloudprnt",
    });
    expect(printer.statusCode, printer.body).toBe(201);
    expect(await stateOf("kitchen")).toBe("on");
    expect((await kitchenRow()).wanted).toBe(false);
  });

  it("Kitchen needs Bar screen & tickets, and turning that off lists Kitchen among what turns off with it", async () => {
    const ask = await call("PATCH", "/modules/bar_screen", { state: "off" });
    expect(ask.json()).toMatchObject({
      applied: false,
      needs_confirm: true,
      turns_off: ["room_ordering", "kitchen"],
    });
    expect(ask.json().question).toBe(
      "Room orders would have nowhere to ring. Turn off Ordering from the room too? These turn off with it: Ordering from the room, Kitchen & food",
    );
    expect(await stateOf("bar_screen")).toBe("on");
  });

  it("turning Kitchen off with a kitchen order being made is refused, directly or with Bar screen & tickets", async () => {
    const check = await owner.query<{ id: string }>(
      "select id from checks where venue_id = $1 limit 1",
      [venueId],
    );
    const order = await owner.query<{ id: string }>(
      `insert into orders (venue_id, check_id, source, status, placed_at, business_date)
         values ($1, $2, 'staff', 'accepted', now(), '2026-09-25') returning id`,
      [venueId, check.rows[0]!.id],
    );
    await owner.query(
      `insert into order_items (venue_id, order_id, qty, unit_cents, name_snapshot, alcohol, tax_category, station)
         values ($1, $2, 1, 1200, 'TEST wings', false, 'food', 'kitchen')`,
      [venueId, order.rows[0]!.id],
    );
    const off = await call("PATCH", "/modules/kitchen", { state: "off" });
    expect(off.statusCode).toBe(409);
    expect(off.json().error.message).toContain("being made (1 now)");
    const both = await call("PATCH", "/modules/bar_screen", { state: "off", confirm: true });
    expect(both.json().error.details).toEqual({ module: "kitchen" });
    expect(await stateOf("kitchen")).toBe("on");
    expect(await stateOf("bar_screen")).toBe("on");

    // Picked up and delivered: nothing is open, so it turns off.
    await owner.query("update orders set status = 'delivered' where id = $1", [order.rows[0]!.id]);
    const done = await call("PATCH", "/modules/kitchen", { state: "off" });
    expect(done.statusCode, done.body).toBe(200);
    expect(await stateOf("kitchen")).toBe("off");
  });

  it("guest food follows Ordering from the room: every guest ordering route is that module's, with no separate switch", async () => {
    const guestRoutes = api.routes.filter(
      (r) =>
        r.principals.some((p) => p === "guest_room" || p === "room_tablet") &&
        /room-session\/(orders|same-again)/.test(r.url),
    );
    expect(guestRoutes.length).toBeGreaterThan(0);
    for (const r of guestRoutes) expect(r.module, r.url).toBe("room_ordering");
    expect(
      api.routes.filter(
        (r) => r.module === "kitchen" && r.principals.some((p) => p.startsWith("guest")),
      ),
    ).toEqual([]);
  });
});
