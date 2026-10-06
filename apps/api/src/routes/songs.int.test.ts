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
 * Bar mode's song queue (M6-18): the seed's queue (round 3, 23 sung, Luis M. singing and six up next,
 * "Song queue · 6"), Sofia R. flagged "Needs a drink credit", Jess P.'s second song in round 4, a move
 * that needs a reason and is logged, Tariq A.'s two tab lines giving his two credits, a drink on a tab
 * earning a credit by itself and a comp taking it back, Kira picked on a paid quick sale, + Singer with a
 * code, and prepaid song credit refused with no song price and bought in cash once one is set.
 */
let db: TestDatabase;
let owner: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
let who: Principal | undefined;
let n = 0;
const clock = new SimulatedClock(SEED_NOW);
const as = (slug: string, role: string) => {
  who = {
    kind: "user",
    userId: ids[slug]!,
    session: "pin",
    memberships: [{ venueId, membershipId: ids[`${slug}.membership`]!, role } as never],
  };
};
const call = (method: "GET" | "POST", path: string, payload?: object) =>
  api.inject({
    method,
    url: `/v1/venues/${venueId}${path}`,
    headers: { "idempotency-key": `songs-${++n}` },
    ...(payload ? { payload } : {}),
  });
type Song = {
  id: string;
  singer: string;
  title: string;
  round: number;
  place: number;
  flag: string | null;
  credits: number;
  holds_credit: boolean;
};
type Queue = {
  round: number;
  songs_sung: number;
  count: number;
  song_price_cents: number | null;
  singing: Song | null;
  up_next: Song[];
  singers: { id: string; display_name: string; credits: number }[];
};
const queue = async () => (await call("GET", "/song-queue")).json() as Queue;
const credits = async (singer: string) =>
  (await queue()).singers.find((s) => s.display_name === singer)!.credits;
const events = async () =>
  Number(
    (
      await owner.query<{ n: string }>(
        "select count(*) as n from venue_events where type = 'song_queue.updated'",
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

describe("the seed's queue", () => {
  it("loads as round 3 with 23 sung: Luis M. singing Mr. Brightside, then six up next", async () => {
    as("maya", "bartender");
    const q = await queue();
    expect(q.round).toBe(3);
    expect(q.songs_sung).toBe(23);
    expect(q.singing).toMatchObject({ singer: "Luis M.", title: "Mr. Brightside" });
    expect(q.up_next.map((s) => s.singer)).toEqual([
      "Jess P.",
      "Kira",
      "Ben T.",
      "Tariq A.",
      "Hana K.",
      "Sofia R.",
    ]);
    expect(q.count).toBe(6);
    expect(JSON.stringify(q)).not.toMatch(/\+\d{10,}|phone/);
  });

  it("flags Sofia R., with no credits and no song price, and nobody else; Hana K.'s cut-off doesn't touch her song", async () => {
    const q = await queue();
    expect(q.song_price_cents).toBeNull();
    const flagged = q.up_next.filter((s) => s.flag).map((s) => [s.singer, s.flag]);
    expect(flagged).toEqual([["Sofia R.", "needs_drink_credit"]]);
    expect(q.up_next.find((s) => s.singer === "Hana K.")).toMatchObject({
      place: 5,
      holds_credit: true,
      flag: null,
    });
  });

  it("Tariq A.'s two tab lines (the Large bucket and a Modelo) gave him his 2 credits", async () => {
    expect(await credits("Tariq A.")).toBe(2);
    const r = await owner.query<{ description: string }>(
      `select l.description from song_credits k join check_lines l on l.id = k.check_line_id
        where k.singer_id = $1 and k.used_at is null order by l.id`,
      [ids["sg_tariq"]],
    );
    expect(r.rows.map((x) => x.description)).toEqual(["Large bucket · 10 beers", "Modelo"]);
  });
});

describe("the rotation", () => {
  it("puts a second song from Jess P. into round 4, not round 3, holding no credit she doesn't have", async () => {
    as("maya", "bartender");
    const before = await events();
    const r = await call("POST", "/song-queue", {
      singer_id: ids["sg_jess"],
      title: "Waterloo",
      artist: "ABBA",
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ round: 4, position: 1, flag: "needs_drink_credit" });
    expect(await events()).toBeGreaterThan(before);
    const q = await queue();
    expect(q.up_next.at(-1)).toMatchObject({ singer: "Jess P.", title: "Waterloo", round: 4 });
    expect(q.count).toBe(7);
  });

  it("moving Sofia R. up needs a reason, and the log shows who and why", async () => {
    as("maya", "bartender");
    const sofia = (await queue()).up_next.find((s) => s.singer === "Sofia R.")!;
    const bare = await call("POST", `/song-queue/${sofia.id}/move`, { direction: "up" });
    expect(bare.statusCode).toBe(400);
    expect(bare.json().error.details.reason).toBe("reason_required");
    const blank = await call("POST", `/song-queue/${sofia.id}/move`, {
      direction: "up",
      reason: "  ",
    });
    expect(blank.statusCode).toBe(400);
    const moved = await call("POST", `/song-queue/${sofia.id}/move`, {
      direction: "up",
      reason: "Her friends are leaving",
    });
    expect(moved.statusCode, moved.body).toBe(200);
    const q = await queue();
    expect(q.up_next.slice(3, 6).map((s) => s.singer)).toEqual(["Tariq A.", "Sofia R.", "Hana K."]);
    const log = (await call("GET", `/song-queue/${sofia.id}/moves`)).json().moves;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ direction: "up", reason: "Her friends are leaving" });
    expect(log[0].by_name).toMatch(/^Maya/);
    const row = await owner.query("select moved_by, move_reason from song_queue where id = $1", [
      sofia.id,
    ]);
    expect(row.rows[0]).toEqual({ moved_by: ids["maya"], move_reason: "Her friends are leaving" });
    // Jess P. is first and can't go higher.
    const jess = q.up_next[0]!;
    const top = await call("POST", `/song-queue/${jess.id}/move`, { direction: "up", reason: "x" });
    expect(top.statusCode).toBe(400);
    expect(top.json().error.details.reason).toBe("at_end");
  });
});

describe("credits", () => {
  it("a drink rung on Jess P.'s tab earns her a credit by itself, and it goes to her flagged round-4 song", async () => {
    as("maya", "bartender");
    const before = await credits("Jess P.");
    const sent = await call("POST", `/checks/${ids["chk_t1"]}/orders`, {
      client_order_id: `songs-round-${++n}`,
      lines: [{ variant_id: ids["menu_redbull_regular"]!, qty: 1 }],
    });
    expect(sent.statusCode, sent.body).toBe(201);
    expect(await credits("Jess P.")).toBe(before + 1);
    const waterloo = (await queue()).up_next.find((s) => s.title === "Waterloo")!;
    expect(waterloo).toMatchObject({ holds_credit: true, flag: null });
  });

  it("a comp of that drink takes the credit back, and her song is flagged again", async () => {
    as("andy", "manager");
    const line = await owner.query<{ id: string }>(
      "select id from check_lines where check_id = $1 and kind = 'item' order by id desc limit 1",
      [ids["chk_t1"]],
    );
    const fixed = await call("POST", `/checks/${ids["chk_t1"]}/lines/${line.rows[0]!.id}/comp`, {
      reason: "Spilled",
      made: true,
    });
    expect([200, 201], fixed.body).toContain(fixed.statusCode);
    expect(await credits("Jess P.")).toBe(1);
    const waterloo = (await queue()).up_next.find((s) => s.title === "Waterloo")!;
    expect(waterloo.flag).toBe("needs_drink_credit");
  });

  it("picking Kira on a drink bought at the bar gives her one credit, once", async () => {
    as("maya", "bartender");
    const before = await credits("Kira");
    const sale = (
      await call("POST", "/quick-sales", {
        client_order_id: `songs-quick-${++n}`,
        lines: [{ variant_id: ids["menu_bud_regular"]!, qty: 1 }],
      })
    ).json();
    const early = await call("POST", `/singers/${ids["sg_kira"]}/credits`, {
      check_id: sale.check_id,
    });
    expect(early.statusCode).toBe(400);
    expect(early.json().error.details.reason).toBe("not_paid");
    const cash = await call("POST", `/checks/${sale.check_id}/payments`, {
      method: "cash",
      amount_cents: sale.amount_due_cents,
      tendered_cents: 2000,
    });
    expect(cash.statusCode, cash.body).toBe(201);
    const picked = await call("POST", `/singers/${ids["sg_kira"]}/credits`, {
      check_id: sale.check_id,
    });
    expect(picked.statusCode, picked.body).toBe(201);
    expect(picked.json()).toMatchObject({ earned: 1, credits: before + 1 });
    expect(await credits("Kira")).toBe(before + 1);
    const again = await call("POST", `/singers/${ids["sg_kira"]}/credits`, {
      check_id: sale.check_id,
    });
    expect(again.json().earned).toBe(0);
    const other = await call("POST", `/singers/${ids["sg_ben"]}/credits`, {
      check_id: sale.check_id,
    });
    expect(other.json().error.details.reason).toBe("already_given");
    // A tab's drinks earn their credits by themselves.
    const tab = await call("POST", `/singers/${ids["sg_kira"]}/credits`, {
      check_id: ids["chk_t3"],
    });
    expect(tab.json().error.details.reason).toBe("not_a_quick_sale");
  });

  it("Sofia R. picked on a sale gets a credit, and her flag clears", async () => {
    as("maya", "bartender");
    const sale = (
      await call("POST", "/quick-sales", {
        client_order_id: `songs-quick-${++n}`,
        lines: [{ variant_id: ids["menu_bud_regular"]!, qty: 1 }],
      })
    ).json();
    await call("POST", `/checks/${sale.check_id}/payments`, {
      method: "cash",
      amount_cents: sale.amount_due_cents,
      tendered_cents: 2000,
    });
    await call("POST", `/singers/${ids["sg_sofia"]}/credits`, { check_id: sale.check_id });
    const sofia = (await queue()).up_next.find((s) => s.singer === "Sofia R.")!;
    expect(sofia).toMatchObject({ holds_credit: true, flag: null, credits: 1 });
  });

  it("prepaid song credit is refused with no song price, and bought in cash at the price once one is set", async () => {
    as("maya", "bartender");
    const refused = await call("POST", `/singers/${ids["sg_ben"]}/credits`, {
      prepaid: { count: 2, tendered_cents: 2000 },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.details.reason).toBe("song_price_not_set");
    await owner.query(
      "update venue_settings set value = jsonb_set(value, '{songPriceCents}', '500') where venue_id = $1 and key = 'barMode'",
      [venueId],
    );
    const before = await credits("Ben T.");
    const bought = await call("POST", `/singers/${ids["sg_ben"]}/credits`, {
      prepaid: { count: 2, tendered_cents: 2000 },
    });
    expect(bought.statusCode, bought.body).toBe(201);
    expect(bought.json()).toMatchObject({
      amount_cents: 1000,
      change_cents: 1000,
      credits: before + 2,
    });
    const ledger = await owner.query<{ kind: string; amount_cents: string; account_kind: string }>(
      `select l.kind, l.amount_cents, a.kind as account_kind from prepaid_ledger l
         join prepaid_accounts a on a.id = l.account_id where a.singer_id = $1`,
      [ids["sg_ben"]],
    );
    expect(ledger.rows).toEqual([
      { kind: "issued", amount_cents: "1000", account_kind: "song_credit" },
    ]);
    await owner.query(
      "update venue_settings set value = jsonb_set(value, '{songPriceCents}', 'null') where venue_id = $1 and key = 'barMode'",
      [venueId],
    );
  });
});

describe("+ Singer", () => {
  it("joins with a display name and a number confirmed by a code, then queues at the end of round 3", async () => {
    as("maya", "bartender");
    const added = await call("POST", "/singers", {
      display_name: "Priya",
      phone_e164: "+16465550199",
    });
    expect(added.statusCode, added.body).toBe(201);
    const singer = added.json();
    expect(singer).toMatchObject({ confirmed: false, code_sent: true });
    const early = await call("POST", "/song-queue", { singer_id: singer.id, title: "Jolene" });
    expect(early.statusCode, early.body).toBe(400);
    expect(early.json().error.details.reason).toBe("phone_not_confirmed");
    const job = await owner.query<{ code: string }>(
      `select payload->'data'->>'code' as code from jobs where kind = 'text.send'
         and payload->>'to' = '+16465550199' order by created_at desc limit 1`,
    );
    const code = job.rows[0]!.code;
    const wrong = await call("POST", `/singers/${singer.id}/verify`, {
      code: code === "000000" ? "111111" : "000000",
    });
    expect(wrong.statusCode, wrong.body).toBe(400);
    expect(wrong.json().error.details.reason).toBe("wrong_code");
    const ok = await call("POST", `/singers/${singer.id}/verify`, { code });
    expect(ok.statusCode, ok.body).toBe(200);
    const queued = await call("POST", "/song-queue", { singer_id: singer.id, title: "Jolene" });
    expect(queued.json()).toMatchObject({ round: 3, flag: "needs_drink_credit" });
    const q = await queue();
    const round3 = q.up_next.filter((s) => s.round === 3).map((s) => s.singer);
    expect(round3.at(-1)).toBe("Priya");
    // The same number again is that singer, with no new code.
    const again = await call("POST", "/singers", {
      display_name: "Priya S.",
      phone_e164: "+16465550199",
    });
    expect(again.json()).toMatchObject({ id: singer.id, confirmed: true, code_sent: false });
  });
});
