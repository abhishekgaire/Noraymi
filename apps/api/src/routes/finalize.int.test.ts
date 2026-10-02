import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  addCheckLine,
  amountDue,
  generateSigningKey,
  insertCheck,
  loadDemoSeed,
  nextCheckNumber,
  publishRulePack,
  withVenue,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

let db: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
const clock = new FrozenClock(SEED_NOW);
const night = "2026-09-25";

const finalize = (checkSlug: string, version?: number) =>
  api.inject({
    method: "POST",
    url: `/v1/venues/${venueId}/checks/${ids[checkSlug]}/finalize`,
    headers: version === undefined ? {} : { "if-match": String(version) },
  });
const linesOf = async (slug: string, rev: number) =>
  (
    await owner.query<{
      kind: string;
      description: string;
      amount_cents: string;
      tax_rate: string | null;
      taxable_base_cents: string | null;
      rule_pack_version: string | null;
    }>(
      `select kind, description, amount_cents, tax_rate::text, taxable_base_cents, rule_pack_version
         from check_lines where check_id = $1 and revision = $2 order by id`,
      [ids[slug], rev],
    )
  ).rows.map((r) => ({
    ...r,
    amount_cents: Number(r.amount_cents),
    taxable_base_cents: r.taxable_base_cents === null ? null : Number(r.taxable_base_cents),
  }));

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  app = appPool(db.url);
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
  const andy: Principal = {
    kind: "user",
    userId: ids["andy"]!,
    session: "passkey",
    memberships: [{ venueId, membershipId: ids["andy.membership"]!, role: "manager" }],
  };
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    moduleCacheMs: 0,
    authenticators: [async () => andy],
  });
  await api.ready();
});

afterAll(async () => {
  await api.close();
  await app.end();
  await owner.end();
  await db.drop();
});

describe("finalizing Room 9", () => {
  it("shows the live totals while the check is open", async () => {
    const r = await api.inject({
      method: "GET",
      url: `/v1/venues/${venueId}/checks/${ids["chk_room9"]}`,
    });
    expect(r.json().totals).toEqual({
      revision: 0,
      subtotal_cents: 48000,
      tax_cents: 4260,
      gratuity_cents: 9600,
      total_cents: 61860,
    });
    expect(r.json().check.opened_label).toMatch(/ (PM|AM) EDT$/);
  });

  it("writes revision 1: room time $322.00, tax $28.58 and $14.02 with their rate and base, gratuity $96.00, $618.60", async () => {
    const r = await finalize("chk_room9");
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      revision: 1,
      subtotal_cents: 48000,
      tax_cents: 4260,
      gratuity_cents: 9600,
      total_cents: 61860,
    });
    expect(await linesOf("chk_room9", 1)).toEqual([
      {
        kind: "room_time",
        description: "Room time · 161 min",
        amount_cents: 32200,
        tax_rate: null,
        taxable_base_cents: null,
        rule_pack_version: null,
      },
      {
        kind: "tax",
        description: "Tax · room time",
        amount_cents: 2858,
        tax_rate: "0.088750",
        taxable_base_cents: 32200,
        rule_pack_version: "2026.10",
      },
      {
        kind: "tax",
        description: "Tax · drinks",
        amount_cents: 1402,
        tax_rate: "0.088750",
        taxable_base_cents: 15800,
        rule_pack_version: "2026.10",
      },
      {
        kind: "gratuity",
        description: "Gratuity (20%)",
        amount_cents: 9600,
        tax_rate: null,
        taxable_base_cents: null,
        rule_pack_version: null,
      },
    ]);
    const rev = (
      await owner.query(
        "select total_cents, gratuity_basis, billing_basis, rule_pack_version from check_revisions where check_id = $1 and rev = 1",
        [ids["chk_room9"]],
      )
    ).rows[0];
    expect(Number(rev.total_cents)).toBe(61860);
    expect(rev.gratuity_basis).toEqual({ rule: "rooms", party_size: 12, pct: 20 });
    expect(rev.billing_basis.segments).toHaveLength(1);
    expect(rev.billing_basis.segments[0]).toMatchObject({
      rate_kind: "per_person",
      hourly_cents: 12000,
      increment_min: 1,
    });
  });

  it("writes revision 2 when the margaritas join: −$42.60 and −$96.00 reversed, $44.91 and $101.20 written, $652.11", async () => {
    const before = await withVenue(app, { venueId }, (c) => amountDue(c, ids["chk_room9"]!));
    await withVenue(app, { venueId }, (c) =>
      addCheckLine(c, venueId, ids["chk_room9"]!, {
        kind: "item",
        description: "Margarita · Peach",
        qty: 2,
        unitCents: 1300,
        amountCents: 2600,
        taxCategory: "drink",
        businessDate: night,
      }),
    );
    const r = await finalize("chk_room9");
    expect(r.json()).toMatchObject({
      revision: 2,
      tax_cents: 4491,
      gratuity_cents: 10120,
      total_cents: 65211,
    });
    const rev2 = await linesOf("chk_room9", 2);
    const sum = (kind: string, sign: 1 | -1) =>
      rev2
        .filter((l) => l.kind === kind && Math.sign(l.amount_cents) === sign)
        .reduce((s, l) => s + l.amount_cents, 0);
    expect([sum("tax", -1), sum("gratuity", -1), sum("tax", 1), sum("gratuity", 1)]).toEqual([
      -4260, -9600, 4491, 10120,
    ]);
    expect(rev2.some((l) => l.kind === "room_time")).toBe(false);
    const after = await withVenue(app, { venueId }, (c) => amountDue(c, ids["chk_room9"]!));
    expect(after - before).toBe(2600 + 231 + 520);
  });

  it("lets one of two racing finalizes win; the other gets 409 version_conflict", async () => {
    const version = (
      await owner.query<{ version: number }>("select version from checks where id = $1", [
        ids["chk_room9"],
      ])
    ).rows[0]!.version;
    const results = await Promise.all([
      finalize("chk_room9", version),
      finalize("chk_room9", version),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.statusCode === 409)!.json().error.code).toBe("version_conflict");
  });
});

describe("check numbers and money rows", () => {
  it("numbers 50 checks opened at once with no gaps and no repeats, some voided by a failed tap", async () => {
    const numbers = await Promise.all(
      Array.from({ length: 50 }, () => nextCheckNumber(app, venueId)),
    );
    await Promise.all(
      numbers.map((number, i) =>
        withVenue(app, { venueId }, async (c) => {
          const id = await insertCheck(c, {
            venueId,
            number,
            kind: "quick",
            businessDate: night,
            openedBy: ids["maya"]!,
          });
          if (i % 7 === 0) await c.query("update checks set status = 'void' where id = $1", [id]);
        }),
      ),
    );
    const sorted = [...numbers].sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(50);
    expect(sorted.at(-1)! - sorted[0]!).toBe(49);
    const voided = await owner.query<{ n: number }>(
      "select count(*)::int as n from checks where number = any($1::bigint[]) and status = 'void'",
      [numbers],
    );
    expect(voided.rows[0]!.n).toBe(8);
  });

  it("never lets the app change or delete a check line or a revision, or delete a check", async () => {
    for (const sql of [
      "update check_lines set amount_cents = 1 where check_id = $1",
      "delete from check_lines where check_id = $1",
      "update check_revisions set total_cents = 1 where check_id = $1",
      "delete from check_revisions where check_id = $1",
      "delete from checks where id = $1",
    ])
      await expect(
        withVenue(app, { venueId }, (c) => c.query(sql, [ids["chk_room9"]])),
        sql,
      ).rejects.toThrow(/permission denied/);
  });
});
