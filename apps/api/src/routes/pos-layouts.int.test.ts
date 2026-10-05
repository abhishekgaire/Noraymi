import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, Temporal, newYorkCounty } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/** Bar POS layouts (M6-01): a draft, published for the next business date; tonight keeps its buttons. */
let db: TestDatabase;
let owner: pg.Pool;
let api: FastifyInstance;
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
const call = (method: "GET" | "POST", path: string, payload?: object) =>
  api.inject({ method, url: `/v1/venues/${venueId}${path}`, ...(payload ? { payload } : {}) });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  await publishRulePack(owner, {
    pack: newYorkCounty,
    effectiveOn: "2026-09-01",
    approvedBy: ["A", "B"],
    privateKeyPem: generateSigningKey().privateKeyPem,
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
  await owner.end();
  await db.drop();
});

describe("bar POS layouts", () => {
  it("West 4's version 1 is tonight's: the Rail board's positions, Bud Light first in Beer", async () => {
    as("maya", "bartender", "pin");
    const v = (await call("GET", "/pos/layouts?station=bar")).json();
    expect(v.tonight.version).toBe(1);
    expect(v.tonight.sections.beer[0]).toBe(ids["menu_bud"]);
    expect(v.tonight.sections.favorites[22]).toBeNull();
    expect(v.next).toBeNull();
  });

  it("published at 10:41 PM on Fri Sep 25, it starts Sat Sep 26; tonight keeps version 1 until the cutover", async () => {
    as("abhishek", "owner");
    const v = (await call("GET", "/pos/layouts?station=bar")).json();
    const favorites = [...v.tonight.sections.favorites];
    favorites[22] = ids["menu_nutrl"];
    const saved = await call("POST", "/pos/layouts", {
      station: "bar",
      sections: { ...v.tonight.sections, favorites },
    });
    expect(saved.statusCode, saved.body).toBe(201);
    const draft = saved.json().draft;
    expect(draft.sections.favorites.slice(0, 22)).toEqual(
      v.tonight.sections.favorites.slice(0, 22),
    );
    const pub = await call("POST", `/pos/layouts/${draft.id}/publish`);
    expect(pub.statusCode, pub.body).toBe(200);
    expect(pub.json().published).toEqual({ station: "bar", version: 2, starts_on: "2026-09-26" });
    expect(pub.json().layouts).toMatchObject({
      tonight: { version: 1 },
      next: { version: 2, starts_on: "2026-09-26" },
      draft: null,
    });
    // 5:59 AM is still Friday's night; from 6:00 AM the bar has version 2.
    clock.set(Temporal.Instant.from("2026-09-26T05:59:00-04:00"));
    expect((await call("GET", "/pos/layouts")).json().tonight.version).toBe(1);
    clock.set(Temporal.Instant.from("2026-09-26T06:00:00-04:00"));
    const sat = (await call("GET", "/pos/layouts")).json();
    expect(sat.tonight.version).toBe(2);
    expect(sat.tonight.sections.favorites[22]).toBe(ids["menu_nutrl"]);
    clock.set(SEED_NOW);
  });

  it("refuses a layout that names another venue's item", async () => {
    as("abhishek", "owner");
    const org = (await owner.query("select org_id from venues where id = $1", [venueId])).rows[0]
      .org_id;
    const other = (
      await owner.query(
        "insert into venues (org_id, name, slug) values ($1, 'Venue B', 'venue-b') returning id",
        [org],
      )
    ).rows[0].id;
    const cat = (
      await owner.query(
        "insert into menu_categories (venue_id, name) values ($1, 'Beer') returning id",
        [other],
      )
    ).rows[0].id;
    const theirs = (
      await owner.query(
        "insert into menu_items (venue_id, category_id, name, alcohol) values ($1, $2, 'B beer', true) returning id",
        [other, cat],
      )
    ).rows[0].id;
    const v = (await call("GET", "/pos/layouts")).json();
    const beer = [...v.tonight.sections.beer];
    beer[20] = theirs;
    const r = await call("POST", "/pos/layouts", {
      station: "bar",
      sections: { ...v.tonight.sections, beer },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details).toEqual({ reason: "unknown_item" });
  });

  it("only Admin edits it: a PIN session can't save or publish", async () => {
    as("maya", "bartender", "pin");
    expect((await call("POST", "/pos/layouts", { station: "bar", sections: {} })).statusCode).toBe(
      403,
    );
  });

  it("the terminal: 3 idle minutes, a 10-second wipe, and Maya on a break while her break punch is open", async () => {
    as("maya", "bartender", "pin");
    expect((await call("GET", "/pos/terminal")).json()).toMatchObject({
      idle_lock_min: 3,
      wipe_lock_sec: 10,
      on_break: false,
    });
    const punch = (kind: string, at: string) =>
      owner.query(
        "insert into time_punches (venue_id, membership_id, kind, duty, at) values ($1, $2, $3, 'bar', $4)",
        [venueId, ids["maya.membership"], kind, at],
      );
    await punch("clock_in", "2026-09-25T20:00:00-04:00");
    await punch("break_start", "2026-09-25T22:30:00-04:00");
    expect((await call("GET", "/pos/terminal")).json().on_break).toBe(true);
    await punch("break_end", "2026-09-25T22:40:00-04:00");
    expect((await call("GET", "/pos/terminal")).json().on_break).toBe(false);
  });
});
