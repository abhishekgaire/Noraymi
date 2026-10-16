import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import {
  SEED_NOW,
  SimulatedClock,
  Temporal,
  newYorkCounty,
  newYorkCountyTaxed,
} from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/**
 * P-18 · Guest screen on the demo seed. Off by default and refused while off. Once on, the bar POS
 * on the bar computer says which check it shows and the screen (a paired guest display following
 * the only bar computer, or the bar computer's own window) reads that check alone, with its tax,
 * the total and the person's unsent drinks; a switch shows the new check and never the old one; a
 * second register doesn't reach it unless Admin points the screen there; English and Spanish; a
 * locked computer can only clear it; another venue's screen sees nothing.
 */
let db: TestDatabase;
let owner: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let venueB: string;
let ids: Record<string, string>;
let who: Principal | undefined;
let at: string | null = null;
let display: string;
let displayB: string;
let beer: { id: string; price: number };
const clock = new SimulatedClock(SEED_NOW);

const person = (
  slug: string,
  role: "bartender" | "front_desk" | "owner",
  device: string | null,
) => {
  who = {
    kind: "user",
    userId: ids[slug]!,
    session: role === "owner" ? "passkey" : "pin",
    memberships: [{ venueId, membershipId: ids[`${slug}.membership`]!, role }],
  };
  at = device;
};
const maya = () => person("maya", "bartender", ids["dev_bar_computer"]!);
const screen = () => {
  who = { kind: "device", deviceId: display, venueId, deviceKind: "guest_display" };
  at = null;
};
const call = (method: "GET" | "POST" | "PUT" | "PATCH", path: string, payload?: object) =>
  api.inject({
    method,
    url: `/v1/venues/${venueId}${path}`,
    ...(payload ? { payload } : {}),
  });
const show = async (checkId: string | null, draft = true) => {
  const r = await call("POST", "/guest-screen/showing", { check_id: checkId, draft });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { following: boolean; version?: number };
};
interface View {
  fp: string;
  unchanged: boolean;
  venue: string;
  register: { id: string; name: string } | null;
  needs_register: boolean;
  check: {
    id: string;
    number: string;
    where: string | null;
    lines: { label: string; amount_cents: number }[];
    totals: { label: string; amount_cents: number }[];
    total_cents: number;
  } | null;
  unsent: { name: string; qty: number; amount_cents: number }[];
  unsent_cents: number;
}
const view = async (query = "") => {
  screen();
  const r = await call("GET", `/guest-screen${query}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as View;
};
const module = (state: "on" | "off") =>
  owner.query(
    `insert into venue_modules (venue_id, module_id, allowed, state) values ($1, 'guest_screen', true, $2)
     on conflict (venue_id, module_id) do update set state = $2, allowed = true`,
    [venueId, state],
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
  display = await one(
    "insert into devices (venue_id, kind, name) values ($1, 'guest_display', 'TEST guest screen') returning id",
    [venueId],
  );
  venueB = await one(
    `insert into venues (org_id, name, slug) select org_id, 'TEST venue B', 'test-guest-screen-b'
       from venues where id = $1 returning id`,
    [venueId],
  );
  displayB = await one(
    "insert into devices (venue_id, kind, name) values ($1, 'guest_display', 'TEST B screen') returning id",
    [venueB],
  );
  const b = (
    await owner.query<{ id: string; price_cents: number }>(
      `select v.id, v.price_cents from menu_variants v join menu_items i on i.venue_id = v.venue_id and i.id = v.item_id
        where v.venue_id = $1 and i.station = 'bar' and v.price_cents > 0 and not exists
              (select 1 from modifier_groups g where g.venue_id = v.venue_id and g.item_id = i.id)
        order by i.name limit 1`,
      [venueId],
    )
  ).rows[0]!;
  beer = { id: b.id, price: b.price_cents };
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    moduleCacheMs: 0,
    authenticators: [
      async (request: FastifyRequest) => {
        // The computer the person signed in at (the register), or none.
        (request as unknown as { session: unknown }).session = at ? { deviceId: at } : undefined;
        return who;
      },
    ],
  });
  await api.ready();
});
afterAll(async () => {
  await api.close();
  await owner.end();
  await db.drop();
});

describe("Guest screen (P-18)", () => {
  it("is off by default: the screen and the register both answer module_off", async () => {
    screen();
    const r = await call("GET", "/guest-screen");
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe("module_off");
    maya();
    const s = await call("POST", "/guest-screen/showing", { check_id: null });
    expect(s.json().error.code).toBe("module_off");
  });

  it("idle, a paired screen shows the venue's name and follows the only bar computer", async () => {
    await module("on");
    const v = await view();
    expect(v.check).toBeNull();
    expect(v.venue).toBeTruthy();
    expect(v.register?.id).toBe(ids["dev_bar_computer"]);
    expect(v.needs_register).toBe(false);
  });

  it("follows the register within one ask: the tab, its tax and total, then the unsent drinks", async () => {
    maya();
    expect((await show(ids["chk_t1"]!)).following).toBe(true);
    const v = await view();
    expect(v.check?.id).toBe(ids["chk_t1"]);
    expect(v.check?.lines.length).toBeGreaterThan(0);
    expect(v.check?.totals.some((l) => /tax/i.test(l.label))).toBe(true);
    expect(v.check?.total_cents).toBeGreaterThan(0);
    // Nothing changed: the fingerprint answers unchanged.
    expect((await view(`?since=${encodeURIComponent(v.fp)}`)).unchanged).toBe(true);
    // Maya rings two drinks on the tab (unsent): the next ask shows them, priced from the menu.
    maya();
    const put = await call("PUT", `/drafts/${ids["chk_t1"]}`, {
      lines: [{ variant_id: beer.id, qty: 2 }],
      version: 0,
    });
    expect(put.statusCode, put.body).toBe(200);
    const after = await view(`?since=${encodeURIComponent(v.fp)}`);
    expect(after.unchanged).toBe(false);
    expect(after.unsent).toEqual([
      expect.objectContaining({ qty: 2, amount_cents: 2 * beer.price }),
    ]);
    expect(after.unsent_cents).toBe(2 * beer.price);
  });

  it("speaks English and Spanish", async () => {
    const en = await view("?lang=en");
    const es = await view("?lang=es");
    expect(es.check?.id).toBe(en.check?.id);
    expect(es.check?.total_cents).toBe(en.check?.total_cents);
    expect(es.check?.totals.map((l) => l.label)).not.toEqual(en.check?.totals.map((l) => l.label));
    expect(es.fp).not.toBe(en.fp);
  });

  it("a switch shows the new check alone, never the one before", async () => {
    maya();
    await show(ids["chk_t2"]!);
    const v = await view();
    expect(v.check?.id).toBe(ids["chk_t2"]);
    expect(v.unsent).toEqual([]);
    maya();
    await show(null);
    expect((await view()).check).toBeNull();
  });

  it("another register doesn't reach the screen until Admin points it there", async () => {
    maya();
    await show(ids["chk_t2"]!);
    person("diego", "front_desk", ids["dev_front_computer"]!);
    await show(ids["chk_t3"]!);
    expect((await view()).check?.id).toBe(ids["chk_t2"]);
    person("abhishek", "owner", null);
    const patch = await call("PATCH", `/devices/${display}`, {
      follows_device_id: ids["dev_front_computer"],
    });
    expect(patch.statusCode, patch.body).toBe(200);
    const v = await view();
    expect(v.register?.id).toBe(ids["dev_front_computer"]);
    expect(v.check?.id).toBe(ids["chk_t3"]);
    // Only a guest screen follows a computer, and only a bar or front-desk computer.
    person("abhishek", "owner", null);
    expect(
      (
        await call("PATCH", `/devices/${ids["dev_bar_printer"]}`, {
          follows_device_id: ids["dev_front_computer"],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await call("PATCH", `/devices/${display}`, { follows_device_id: ids["dev_router"] }))
        .statusCode,
    ).toBe(404);
    expect(
      (await call("PATCH", `/devices/${display}`, { follows_device_id: null })).statusCode,
    ).toBe(200);
    expect((await view()).check?.id).toBe(ids["chk_t2"]);
  });

  it("a phone drives no screen, and a locked computer can only clear its screen", async () => {
    person("maya", "bartender", ids["dev_phone_maya"]!);
    expect((await show(ids["chk_t4"]!)).following).toBe(false);
    person("maya", "bartender", null);
    expect((await show(ids["chk_t4"]!)).following).toBe(false);
    expect((await view()).check?.id).toBe(ids["chk_t2"]);
    who = {
      kind: "device",
      deviceId: ids["dev_bar_computer"]!,
      venueId,
      deviceKind: "bar_computer",
    };
    at = null;
    const refused = await call("POST", "/guest-screen/showing", { check_id: ids["chk_t4"] });
    expect(refused.statusCode).toBe(403);
    expect((await call("POST", "/guest-screen/showing", { check_id: null })).statusCode).toBe(200);
    expect((await view()).check).toBeNull();
    // The bar computer's own window follows itself.
    maya();
    await show(ids["chk_t5"]!);
    who = {
      kind: "device",
      deviceId: ids["dev_bar_computer"]!,
      venueId,
      deviceKind: "bar_computer",
    };
    at = null;
    const own = await call("GET", "/guest-screen");
    expect(own.json().check.id).toBe(ids["chk_t5"]);
  });

  it("a register gone quiet for over 3 minutes shows the venue's name", async () => {
    maya();
    await show(ids["chk_t1"]!);
    expect((await view()).check?.id).toBe(ids["chk_t1"]);
    clock.advance(Temporal.Duration.from({ minutes: 4 }));
    expect((await view()).check).toBeNull();
    maya();
    await show(ids["chk_t1"]!);
    expect((await view()).check?.id).toBe(ids["chk_t1"]);
  });

  it("walls venues: another venue's screen is refused here, and a check it can't see is not found", async () => {
    await owner.query(
      `insert into venue_modules (venue_id, module_id, allowed, state) values ($1, 'guest_screen', true, 'on')
       on conflict (venue_id, module_id) do update set state = 'on', allowed = true`,
      [venueB],
    );
    who = { kind: "device", deviceId: displayB, venueId: venueB, deviceKind: "guest_display" };
    at = null;
    expect((await call("GET", "/guest-screen")).statusCode).toBe(403);
    const own = await api.inject({ method: "GET", url: `/v1/venues/${venueB}/guest-screen` });
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json().check).toBeNull();
    expect(own.json().register).toBeNull();
    maya();
    const missing = await call("POST", "/guest-screen/showing", {
      check_id: "00000000-0000-4000-8000-00000000abcd",
    });
    expect(missing.statusCode).toBe(404);
    // Row-level security: venue A's register rows are invisible from venue B.
    const c = await owner.connect();
    try {
      await c.query("begin");
      await c.query("set local role app_rw");
      await c.query("select set_config('app.venue_id', $1, true)", [venueB]);
      const seen = await c.query("select 1 from guest_screens");
      expect(seen.rowCount).toBe(0);
      await c.query("rollback");
    } finally {
      c.release();
    }
  });
});
