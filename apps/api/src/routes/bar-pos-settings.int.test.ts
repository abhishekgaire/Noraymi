import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/**
 * Admin → Bar POS, the settings part (M6-25; Staff screens and the bar POS · Admin → Bar POS;
 * Settings · When a change starts): limits, locks, tip path, order aging and tabs are live at
 * once; the consent line gets a new version when the tab settings change it, and tabs already
 * open keep theirs; a layout waiting for tomorrow survives a save tonight.
 */
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
const call = (method: "GET" | "POST" | "PUT", path: string, payload?: object) =>
  api.inject({ method, url: `/v1/venues/${venueId}${path}`, ...(payload ? { payload } : {}) });
type Pos = {
  layouts: Record<string, number>;
  reasonOnly: { eachCents: number; perShiftCents: number };
  wipeLockSec: number;
  muteSec: number;
  orderAging: { phonesSec: number; amberSec: number; pinkSec: number; callSec: number };
};
const pos = async (date?: string) =>
  (await call("GET", `/settings/pos${date ? `?business_date=${date}` : ""}`)).json().value as Pos;
const save = (values: Record<string, unknown>) => call("PUT", "/settings", { values });

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
  });
  await api.ready();
});

afterAll(async () => {
  await api.close();
  await owner.end();
  await db.drop();
});

describe("Admin → Bar POS settings", () => {
  it("West 4 shows $25 and $75, 3 min and 10 s, the reader, 30 s / 2 / 4 / 6 min, the chime, Mute 60 s, $50, $600 and 4:30 AM", async () => {
    as("abhishek", "owner");
    expect(await pos()).toMatchObject({
      reasonOnly: { eachCents: 2500, perShiftCents: 7500 },
      idleLockMin: 3,
      wipeLockSec: 10,
      barTabTip: "reader",
      orderAging: { phonesSec: 30, amberSec: 120, pinkSec: 240, callSec: 360 },
      chime: true,
      muteSec: 60,
    });
    expect((await call("GET", "/settings/tabs")).json().value).toEqual({
      openingHoldCents: 5000,
      flagOverCents: 60000,
      cutOffAt: "04:30",
    });
  });

  it("a per-shift limit of 0 sends Maya's $12 void for approval", async () => {
    as("abhishek", "owner");
    const current = await pos();
    const r = await save({
      pos: { ...current, reasonOnly: { eachCents: 2500, perShiftCents: 0 } },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().saved[0].startsOn).toBe("2026-09-25");
    as("maya", "bartender", "pin");
    const jager = (await call("GET", `/checks/${ids["chk_t1"]}`))
      .json()
      .lines.find(
        (l: { description: string; kind: string }) =>
          l.description === "Jäger Bomb" && l.kind === "item",
      ) as { id: number };
    const v = await call("POST", `/checks/${ids["chk_t1"]}/lines/${jager.id}/void`, {
      reason: "Rang it wrong",
      made: false,
    });
    expect(v.statusCode, v.body).toBe(202);
    expect(v.json().status).toBe("approval_pending");
    as("abhishek", "owner");
    expect((await save({ pos: current })).statusCode).toBe(200);
  });

  it("an opening hold of $60 makes a new consent line for new tabs; Jess P.'s open tab keeps the one read to her", async () => {
    as("maya", "bartender", "pin");
    const before = (await call("GET", "/tabs/consent")).json();
    expect(before.text).toMatch(/^We'll hold \$50 on this card/);
    const jess = async () =>
      (
        await owner.query<{ v: string }>(
          "select consent_text_version as v from tabs where id = $1",
          [ids["tab_t1"]],
        )
      ).rows[0]!.v;
    const jessBefore = await jess();
    as("abhishek", "owner");
    const tabs = (await call("GET", "/settings/tabs")).json().value;
    const r = await save({ tabs: { ...tabs, openingHoldCents: 6000 } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().consent_version).toBe(before.version + 1);
    const row = (
      await owner.query<{ text: string }>(
        "select text from policy_versions where venue_id = $1 and kind = 'tab_consent' and version = $2",
        [venueId, before.version + 1],
      )
    ).rows[0]!;
    expect(row.text).toBe(
      "We'll hold $60 on this card and add to it as you order. We charge your tab when you close out, or at 4:30 AM if it's still open. Add your tip on the reader.",
    );
    as("maya", "bartender", "pin");
    const after = (await call("GET", "/tabs/consent")).json();
    expect(after).toMatchObject({ version: before.version + 1, hold_cents: 6000 });
    expect(await jess()).toBe(jessBefore);
  });

  it("a new amber time reaches the bar screens' orders list at once", async () => {
    as("maya", "bartender", "pin");
    expect((await call("GET", "/orders?status=ringing,held")).json().aging).toEqual({
      phones_sec: 30,
      amber_sec: 120,
      pink_sec: 240,
      call_sec: 360,
      chime: true,
      mute_sec: 60,
    });
    as("abhishek", "owner");
    const current = await pos();
    const r = await save({
      pos: { ...current, orderAging: { ...current.orderAging, amberSec: 60 }, muteSec: 30 },
    });
    expect(r.statusCode, r.body).toBe(200);
    as("maya", "bartender", "pin");
    expect((await call("GET", "/orders?status=ringing,held")).json().aging).toMatchObject({
      amber_sec: 60,
      mute_sec: 30,
    });
  });

  it("refuses aging out of order and a flag under the hold, and saves nothing", async () => {
    as("abhishek", "owner");
    const current = await pos();
    const r = await save({
      pos: { ...current, orderAging: { ...current.orderAging, pinkSec: 30 } },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toContain("Order aging runs in order");
    const tabs = (await call("GET", "/settings/tabs")).json().value;
    expect((await save({ tabs: { ...tabs, flagOverCents: 100 } })).statusCode).toBe(400);
    expect((await pos()).orderAging.pinkSec).toBe(240);
  });

  it("a layout published tonight still starts Sat Sep 26 after other bar POS changes are saved tonight", async () => {
    as("abhishek", "owner");
    const v = (await call("GET", "/pos/layouts?station=bar")).json();
    const favorites = [...v.tonight.sections.favorites];
    favorites[22] = ids["menu_nutrl"];
    const draft = (
      await call("POST", "/pos/layouts", {
        station: "bar",
        sections: { ...v.tonight.sections, favorites },
      })
    ).json().draft;
    expect((await call("POST", `/pos/layouts/${draft.id}/publish`)).statusCode).toBe(200);
    // Admin's draft holds tonight's pos, layouts and all: Mute changes tonight, the layout still waits.
    const tonight = await pos();
    expect(tonight.layouts).toEqual({ bar: 1 });
    expect((await save({ pos: { ...tonight, muteSec: 45 } })).statusCode).toBe(200);
    expect(await pos()).toMatchObject({ layouts: { bar: 1 }, muteSec: 45 });
    expect(await pos("2026-09-26")).toMatchObject({ layouts: { bar: 2 }, muteSec: 45 });
    // A layout and a lock saved together: the lock is live at once, the layout waits.
    const both = await save({ pos: { ...(await pos("2026-09-26")), wipeLockSec: 5 } });
    expect(both.statusCode, both.body).toBe(200);
    expect(await pos()).toMatchObject({ layouts: { bar: 1 }, wipeLockSec: 5 });
    expect(await pos("2026-09-26")).toMatchObject({ layouts: { bar: 2 }, wipeLockSec: 5 });
  });
});
