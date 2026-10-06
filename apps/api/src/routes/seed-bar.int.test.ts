import { readFileSync } from "node:fs";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { seedFiles } from "../files/seed-files.js";
import { makeS3 } from "../s3.js";
import { StripeClient } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { seedStripe, tabCards } from "../stripe/seed-stripe.js";
import { fakeStripeSettings } from "../stripe/settings.js";

/**
 * The seed's bar after a load (M6-27): `pnpm seed`, then `stripe:seed` and `seed:files`, as staging runs
 * them, checked against the seed file's own `expected_at_now` numbers.
 */
type SeedFile = {
  bar_tabs: { id: string; check: string; name: string; hold_cents: number; card_last4: string }[];
  checks: {
    id: string;
    expected_at_now?: { drinks_cents: number; tax_cents: number; total_cents: number };
  }[];
  tip_slips: { name: string; tab_total_cents: number }[];
  song_queue: { up_next: unknown[] };
};
const seed = JSON.parse(
  readFileSync(new URL("../../../../seed/west4-friday.json", import.meta.url), "utf8"),
) as SeedFile;

let db: TestDatabase;
let owner: pg.Pool;
let api: FastifyInstance;
let fake: FakeStripe;
let venueId: string;
let ids: Record<string, string>;
let who: Principal | undefined;
const s3 = makeS3();
const call = (path: string) => api.inject({ method: "GET", url: `/v1/venues/${venueId}${path}` });
type TabView = {
  id: string;
  name: string;
  open: boolean;
  state: string;
  hold_cents: number;
  hold: { can_grow: boolean; declined: boolean } | null;
  cut_off: { by: string } | null;
  waiting_for: string | null;
  totals: { tax_cents: number; total_cents: number };
};

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
  fake = new FakeStripe();
  const stripe = new StripeClient(fakeStripeSettings(await fake.start()));
  await seedStripe(owner, stripe, () => undefined);
  await seedFiles(owner, s3, () => undefined);
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock: new SimulatedClock(SEED_NOW),
    moduleCacheMs: 0,
    authenticators: [async () => who],
    stripe,
  });
  await api.ready();
  who = {
    kind: "user",
    userId: ids["maya"]!,
    session: "pin",
    memberships: [{ venueId, membershipId: ids["maya.membership"]!, role: "bartender" } as never],
  };
});

afterAll(async () => {
  await api?.close();
  await fake?.stop();
  await owner?.end();
  await db?.drop();
});

describe("the seed's bar after a load", () => {
  it("lists the five open tabs at the seed's expected totals, each on a hold that can grow", async () => {
    const tabs = ((await call("/tabs")).json().tabs as TabView[]).filter((x) => x.open);
    expect(tabs.map((x) => x.name)).toEqual(seed.bar_tabs.map((t) => t.name));
    for (const t of seed.bar_tabs) {
      const view = tabs.find((x) => x.id === ids[t.id])!;
      const expected = seed.checks.find((c) => c.id === t.check)!.expected_at_now!;
      expect(view.totals).toMatchObject({
        tax_cents: expected.tax_cents,
        total_cents: expected.total_cents,
      });
      expect(view.hold_cents).toBe(t.hold_cents);
      expect(view.hold).toMatchObject({ can_grow: true, declined: false });
    }
    // $43.55, $32.66, $63.15, $86.01 and $13.07.
    expect(tabs.map((x) => x.totals.total_cents)).toEqual([4355, 3266, 6315, 8601, 1307]);
    expect(tabs.find((x) => x.name === "Hana K.")!.cut_off).toMatchObject({ by: "Andy" });
    expect(tabs.find((x) => x.name === "Tariq A.")!.waiting_for).toMatch(/^Andy/);
  });

  it("holds each tab on Stripe: Luis M.'s and Tariq A.'s raised from the $50.00 opening hold", async () => {
    const holds = await owner.query<{ slug: string; pi: string; gen: string | null }>(
      `select s.slug, p.stripe_pi_id as pi, p.generated_card_pm as gen
         from seed_ids s join tabs t on t.id = s.row_id join payments p on p.id = t.payment_id
        where s.entity = 'tabs' order by s.slug`,
    );
    expect(holds.rows).toHaveLength(8);
    for (const h of holds.rows) {
      const pi = fake.objects.get(h.pi)!;
      expect(pi).toMatchObject({ status: "requires_capture", capture_method: "manual" });
      expect(h.gen, h.slug).not.toBeNull();
    }
    const luis = fake.objects.get(holds.rows.find((h) => h.slug === "tab_t2")!.pi)!;
    expect(luis).toMatchObject({ amount: 8000, amount_capturable: 8000, _increments: 1 });
    const tariq = fake.objects.get(holds.rows.find((h) => h.slug === "tab_t5")!.pi)!;
    // Every tab opens at the $50.00 opening hold, so Tariq A.'s $100.00 grew too, in one raise.
    expect(tariq).toMatchObject({ amount: 10000, amount_capturable: 10000, _increments: 1 });
    const jess = fake.objects.get(holds.rows.find((h) => h.slug === "tab_t1")!.pi)!;
    expect(jess).toMatchObject({ amount: 5000, amount_capturable: 5000 });
    expect(jess["_increments"] ?? 0).toBe(0);
  });

  it("keeps the seed's cards on our rows, each tab with its own card fingerprint", async () => {
    const tabs = await owner.query<{ last4: string; fp: string | null }>(
      "select card_last4 as last4, card_fingerprint as fp from tabs where venue_id = $1",
      [venueId],
    );
    expect(tabs.rows).toHaveLength(8);
    for (const t of tabs.rows) expect(t.fp).toMatch(new RegExp(`${t.last4}$`));
    expect(new Set(tabs.rows.map((t) => t.fp)).size).toBe(8);
    const jess = await owner.query<{ brand: string; last4: string }>(
      "select card_brand as brand, card_last4 as last4 from tabs where id = $1",
      [ids["tab_t1"]],
    );
    expect(jess.rows[0]).toEqual({ brand: "Visa", last4: "4417" });
  });

  it("lists the three slips to enter, each with its photo in the object store", async () => {
    const slips = (await call("/tabs?state=awaiting_tip")).json().tabs as TabView[];
    expect(slips.map((x) => x.name)).toEqual(
      seed.tip_slips.map((s) => s.name.replace(/^Bar tab · /, "")),
    );
    const photos = await owner.query<{ key: string; bytes: number; type: string; due: number }>(
      `select f.storage_key as key, f.bytes::int as bytes, f.content_type as type, c.balance_cents as due
         from tab_closings c join files f on f.id = c.slip_photo_file_id
        where c.venue_id = $1 order by c.created_at`,
      [venueId],
    );
    expect(photos.rows.map((p) => p.due)).toEqual(seed.tip_slips.map((s) => s.tab_total_cents));
    for (const p of photos.rows) {
      const object = await s3.client.send(
        new GetObjectCommand({ Bucket: s3.bucketFiles, Key: p.key }),
      );
      const body = Buffer.from(await object.Body!.transformToByteArray());
      expect(p).toMatchObject({ type: "image/png", bytes: body.byteLength });
      expect(body.byteLength).toBeGreaterThan(100);
      expect(body.subarray(1, 4).toString("ascii")).toBe("PNG");
    }
  });

  it("reads Song queue · 6", async () => {
    const r = await call("/song-queue");
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().count).toBe(seed.song_queue.up_next.length);
    expect(r.json().count).toBe(6);
  });
});

describe("the cards a sandbox taps", () => {
  it("gives each Stripe test card to one tab only; a tab left over carries no fingerprint", () => {
    const card = tabCards(false);
    expect(card("Visa", "5120")).toEqual({ number: "4242424242424242", fingerprint: true });
    expect(card("Visa", "4417")).toEqual({ number: "4000056655665556", fingerprint: true });
    expect(card("Visa", "8830")).toEqual({ number: "4242424242424242", fingerprint: false });
    expect(card("Amex", "7712")).toEqual({ number: "378282246310005", fingerprint: true });
  });

  it("taps the brand's test-card prefix and the seed's last four on the fake", () => {
    expect(tabCards(true)("Mastercard", "2281")).toEqual({
      number: "5555550000002281",
      fingerprint: true,
    });
  });
});
