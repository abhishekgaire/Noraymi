import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import {
  SEED_NOW,
  SimulatedClock,
  newYorkCounty,
  newYorkCountyTaxed,
  type RulePack,
} from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/**
 * Started and Skip (M6-19): Maya's Started on Luis M. at 10:39 PM (a $0.00 "Mr. Brightside · The Killers"
 * line on his tab, his credit spent, the play log written); Kira with no tab spending her credit with no
 * line; Jess P.'s skip, free, with her credit back; Sofia R. refused until she has a credit; Hana K.'s
 * song starting on her cut-off tab; and a $5.00 song price posting $5.00 and its tax on a venue whose
 * rule pack taxes songs.
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
const call = (method: "GET" | "POST", path: string, key = true) =>
  api.inject({
    method,
    url: `/v1/venues/${venueId}${path}`,
    headers: key ? { "idempotency-key": `song-start-${++n}` } : {},
  });
const start = (song: string) => call("POST", `/song-queue/${ids[song]}/start`);
type Queue = {
  songs_sung: number;
  count: number;
  singing: { id: string; singer: string; title: string } | null;
  up_next: { id: string; singer: string; flag: string | null; holds_credit: boolean }[];
  singers: { id: string; display_name: string; credits: number }[];
};
const queue = async () => (await call("GET", "/song-queue", false)).json() as Queue;
const openCredits = async (singer: string) =>
  (
    await owner.query<{ id: string; used_by_queue_id: string | null; used_at: string | null }>(
      `select id, used_by_queue_id, used_at from song_credits
        where singer_id = $1 and forfeited_at is null order by earned_at, id`,
      [ids[singer]],
    )
  ).rows;
const linesOn = async (check: string) =>
  (
    await owner.query<{
      description: string;
      amount_cents: string;
      tax_category: string | null;
      kind: string;
      added_by: string | null;
    }>(
      "select description, amount_cents, tax_category, kind, added_by from check_lines where check_id = $1 order by id",
      [ids[check]],
    )
  ).rows;
const plays = async (song: string) =>
  (
    await owner.query<{
      check_id: string | null;
      title: string;
      artist: string | null;
      started_at: Date;
      source: string;
      started_by: string | null;
    }>(
      "select check_id, title, artist, started_at, source, started_by from song_plays where queue_id = $1",
      [ids[song]],
    )
  ).rows;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  const key = generateSigningKey().privateKeyPem;
  // The test venue's pack taxes songs (GA-M11), beside the built-in packs West 4 uses.
  const songsTaxed: RulePack = {
    ...newYorkCountyTaxed,
    id: "test-songs-taxed",
    salesTax: {
      ...newYorkCountyTaxed.salesTax,
      taxedCategories: ["room_time", "drink", "damage", "song"],
    },
  };
  for (const pack of [newYorkCounty, newYorkCountyTaxed, songsTaxed])
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

describe("Started", () => {
  it("the seed's play log has Luis M.'s song, started by Maya at 10:39 PM on his tab", async () => {
    const [play] = await plays("song_sg_luis");
    expect(play).toMatchObject({
      check_id: ids["chk_t2"],
      title: "Mr. Brightside",
      artist: "The Killers",
      source: "staff",
      started_by: ids["maya"],
    });
    expect(play!.started_at.toISOString().slice(0, 16)).toBe("2026-09-26T02:39");
  });

  it("Maya's Started on Luis M. at 10:39 PM posts a $0.00 line, spends his credit and writes the play log", async () => {
    // Back to 10:39 PM, before Maya's tap: his song queued, holding his credit, no line, no play.
    const song = ids["song_sg_luis"]!;
    await owner.query("delete from song_plays where queue_id = $1", [song]);
    await owner.query(
      "update song_queue set status = 'queued', started_at = null, started_by = null, check_line_id = null where id = $1",
      [song],
    );
    await owner.query(
      "delete from check_lines where check_id = $1 and kind = 'song' and description = 'Mr. Brightside · The Killers'",
      [ids["chk_t2"]],
    );
    await owner.query("update song_credits set used_at = null where used_by_queue_id = $1", [song]);
    clock.set(SEED_NOW.subtract({ minutes: 2 }));
    as("maya", "bartender");
    const lines = (await linesOn("chk_t2")).length;
    const res = await start("song_sg_luis");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      paid_with: "drink_credit",
      amount_cents: 0,
      check_id: ids["chk_t2"],
    });
    const after = await linesOn("chk_t2");
    expect(after.length).toBe(lines + 1);
    expect(after.at(-1)).toEqual({
      description: "Mr. Brightside · The Killers",
      amount_cents: "0",
      tax_category: "song",
      kind: "song",
      added_by: ids["maya"],
    });
    const spent = (await openCredits("sg_luis")).filter((k) => k.used_by_queue_id === song);
    expect(spent).toHaveLength(1);
    expect(spent[0]!.used_at).not.toBeNull();
    const [play] = await plays("song_sg_luis");
    expect(play).toMatchObject({
      check_id: ids["chk_t2"],
      title: "Mr. Brightside",
      source: "staff",
    });
    expect(play!.started_at.toISOString().slice(0, 16)).toBe("2026-09-26T02:39");
    const q = await queue();
    expect(q.singing).toMatchObject({ singer: "Luis M.", title: "Mr. Brightside" });
    expect(q.songs_sung).toBe(23);
    expect(q.count).toBe(6);
    clock.set(SEED_NOW);
  });

  it("Started on Kira (no tab, 1 credit) spends her credit and posts no line; Luis M. is sung", async () => {
    as("maya", "bartender");
    expect((await openCredits("sg_kira")).filter((k) => !k.used_at)).toHaveLength(1);
    const res = await start("song_sg_kira");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ paid_with: "drink_credit", line_id: null, check_id: null });
    expect((await openCredits("sg_kira")).filter((k) => !k.used_at)).toHaveLength(0);
    const [play] = await plays("song_sg_kira");
    expect(play).toMatchObject({ check_id: null, title: "Valerie", artist: "Amy Winehouse" });
    const q = await queue();
    expect(q.singing).toMatchObject({ singer: "Kira" });
    expect(q.songs_sung).toBe(24);
    expect(q.count).toBe(5);
    expect(q.singers.find((s) => s.display_name === "Kira")!.credits).toBe(0);
    // Started twice is refused: it isn't waiting any more.
    const again = await start("song_sg_kira");
    expect(again.statusCode).toBe(400);
    expect(again.json().error.details.reason).toBe("song_not_queued");
  });

  it("Started needs an Idempotency-Key, as a money route does", async () => {
    as("maya", "bartender");
    const res = await call("POST", `/song-queue/${ids["song_sg_ben"]}/start`, false);
    expect(res.statusCode).toBe(400);
  });

  it("Sofia R.'s song can't start until she has a credit", async () => {
    as("maya", "bartender");
    const refused = await start("song_sg_sofia");
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.details.reason).toBe("needs_drink_credit");
    expect(await plays("song_sg_sofia")).toHaveLength(0);
    // A drink bought at the bar, with Sofia R. picked: one credit.
    await owner.query(
      `insert into song_credits (venue_id, singer_id, source, given_by, earned_at)
       values ($1, $2, 'drink', $3, $4)`,
      [venueId, ids["sg_sofia"], ids["maya"], SEED_NOW.toString()],
    );
    const res = await start("song_sg_sofia");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ paid_with: "drink_credit", amount_cents: 0 });
  });

  it("Hana K.'s song starts on her cut-off tab: the cut-off never stops a song", async () => {
    as("maya", "bartender");
    const res = await start("song_sg_hana");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ paid_with: "drink_credit", check_id: ids["chk_t4"] });
    expect((await linesOn("chk_t4")).at(-1)).toMatchObject({
      description: "Someone Like You · Adele",
      amount_cents: "0",
      tax_category: "song",
    });
  });
});

describe("Skip", () => {
  it("skipping Jess P.'s song gives her credit back and charges nothing", async () => {
    as("maya", "bartender");
    const song = ids["song_sg_jess"]!;
    const held = (await openCredits("sg_jess")).find((k) => k.used_by_queue_id === song)!;
    expect(held).toBeDefined();
    const lines = (await linesOn("chk_t1")).length;
    const res = await call("POST", `/song-queue/${song}/skip`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: "skipped", credit_returned: true });
    const back = (await openCredits("sg_jess")).find((k) => k.id === held.id)!;
    expect(back).toMatchObject({ used_by_queue_id: null, used_at: null });
    expect((await linesOn("chk_t1")).length).toBe(lines);
    expect(await plays("song_sg_jess")).toHaveLength(0);
    const q = await queue();
    expect(q.up_next.find((s) => s.id === song)).toBeUndefined();
    expect(q.singers.find((s) => s.display_name === "Jess P.")!.credits).toBeGreaterThan(0);
  });
});

describe("a song price", () => {
  it("on a test venue with a $5.00 song price, Started posts $5.00 and its tax to the singer's tab", async () => {
    await owner.query("update venues set rule_pack_id = 'test-songs-taxed' where id = $1", [
      venueId,
    ]);
    await owner.query(
      "update venue_settings set value = jsonb_set(value, '{songPriceCents}', '500') where venue_id = $1 and key = 'barMode'",
      [venueId],
    );
    // Tariq A. has spent his credits: his song has none, so it's charged at the price.
    const song = ids["song_sg_tariq"]!;
    await owner.query("update song_queue set credit_id = null where id = $1", [song]);
    await owner.query(
      "update song_credits set used_by_queue_id = null, forfeited_at = $2 where singer_id = $1 and used_at is null",
      [ids["sg_tariq"], SEED_NOW.toString()],
    );
    as("maya", "bartender");
    const tabTotal = async () =>
      (await call("GET", "/tabs", false))
        .json<{ tabs: { id: string; totals: { total_cents: number } }[] }>()
        .tabs.find((t) => t.id === ids["tab_t5"])!.totals.total_cents;
    const before = await tabTotal();
    const res = await start("song_sg_tariq");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ paid_with: "price", amount_cents: 500 });
    expect((await linesOn("chk_t5")).at(-1)).toMatchObject({
      description: "Sweet Caroline · Neil Diamond",
      amount_cents: "500",
      tax_category: "song",
    });
    // $5.00 and the tax it adds: tax is worked once on the check's taxed base (Money rules 8), at 8.875%
    // rounded half up, so the song adds the tax on the base with it less the tax on the base without it.
    const base = Number(
      (
        await owner.query<{ b: string }>(
          `select coalesce(sum(amount_cents), 0) as b from check_lines
            where check_id = $1 and tax_category in ('room_time', 'drink', 'damage', 'song')`,
          [ids["chk_t5"]],
        )
      ).rows[0]!.b,
    );
    const tax = (cents: number) => Math.floor((cents * 8875 + 50_000) / 100_000);
    expect((await tabTotal()) - before).toBe(500 + tax(base) - tax(base - 500));
    await owner.query("update venues set rule_pack_id = 'us-ny-new-york-county' where id = $1", [
      venueId,
    ]);
  });

  it("with a song price, a singer with no tab and no credit is asked to open a tab or buy song credit", async () => {
    as("maya", "bartender");
    const res = await start("song_sg_ben");
    // Ben T. still holds his credit: it's spent with no line.
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ paid_with: "drink_credit", line_id: null });
    const add = await api.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/song-queue`,
      headers: { "idempotency-key": `song-start-${++n}` },
      payload: { singer_id: ids["sg_ben"], title: "Wanted Dead or Alive" },
    });
    expect(add.statusCode, add.body).toBe(201);
    const refused = await call("POST", `/song-queue/${add.json().id}/start`);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.details.reason).toBe("needs_tab");
  });

  it("prepaid song credit bought in cash is spent at Started: the value is redeemed, with no tab no line", async () => {
    as("maya", "bartender");
    const bought = await api.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/singers/${ids["sg_ben"]}/credits`,
      headers: { "idempotency-key": `song-start-${++n}` },
      payload: { prepaid: { count: 1, tendered_cents: 500 } },
    });
    expect(bought.statusCode, bought.body).toBe(201);
    const q = await queue();
    const next = q.up_next.find((s) => s.singer === "Ben T.")!;
    const res = await call("POST", `/song-queue/${next.id}/start`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      paid_with: "prepaid_credit",
      amount_cents: 500,
      line_id: null,
    });
    const ledger = await owner.query<{ kind: string; amount_cents: string }>(
      `select l.kind, l.amount_cents from prepaid_ledger l join prepaid_accounts a on a.id = l.account_id
        where a.singer_id = $1 order by l.at, l.kind desc`,
      [ids["sg_ben"]],
    );
    expect(ledger.rows).toEqual([
      { kind: "issued", amount_cents: "500" },
      { kind: "redeemed", amount_cents: "-500" },
    ]);
  });

  it("a prepaid song credit on a tab posts its value as the song line, paid by redeeming it onto the tab", async () => {
    as("maya", "bartender");
    const bought = await api.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/singers/${ids["sg_tariq"]}/credits`,
      headers: { "idempotency-key": `song-start-${++n}` },
      payload: { prepaid: { count: 1, tendered_cents: 500 } },
    });
    expect(bought.statusCode, bought.body).toBe(201);
    const add = await api.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/song-queue`,
      headers: { "idempotency-key": `song-start-${++n}` },
      payload: { singer_id: ids["sg_tariq"], title: "Cracklin' Rosie", artist: "Neil Diamond" },
    });
    expect(add.statusCode, add.body).toBe(201);
    const res = await call("POST", `/song-queue/${add.json().id}/start`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ paid_with: "prepaid_credit", amount_cents: 500 });
    expect((await linesOn("chk_t5")).at(-1)).toMatchObject({
      description: "Cracklin' Rosie · Neil Diamond",
      amount_cents: "500",
      tax_category: "song",
    });
    const paid = await owner.query<{ method: string; amount_cents: string }>(
      `select p.method, p.amount_cents from payments p join payment_allocations a on a.payment_id = p.id
        where a.check_id = $1 and p.method = 'prepaid'`,
      [ids["chk_t5"]],
    );
    expect(paid.rows).toEqual([{ method: "prepaid", amount_cents: "500" }]);
  });
});
