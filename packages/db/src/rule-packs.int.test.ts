import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newYorkCounty, Temporal } from "@west4/shared";
import { businessDate } from "@west4/rules";
import {
  generateSigningKey,
  publishRulePack,
  rulePackFor,
  rulePackVersions,
  signRulePack,
} from "./rule-packs.js";
import { withVenue } from "./tenancy.js";
import {
  appPool,
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "./test-helpers.js";

let db: TestDatabase;
let owner: pg.Client;
let pool: pg.Pool;
let v: TwoVenues;
const key = generateSigningKey();
const NY = "America/New_York";
const dateAt = (iso: string) => businessDate(Temporal.Instant.from(iso), NY, "06:00").businessDate;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  owner = new pg.Client({ connectionString: db.url });
  await owner.connect();
  pool = appPool(db.url);
  await publishRulePack(owner, {
    pack: newYorkCounty,
    effectiveOn: "2026-09-01",
    approvedBy: ["Abhishek Gaire", "Claude Code"],
    privateKeyPem: key.privateKeyPem,
  });
});

afterAll(async () => {
  await pool.end();
  await owner.end();
  await db.drop();
});

describe("rulePackFor", () => {
  it("West 4 reads us-ny-new-york-county 2026.09 on business date Fri Sep 25, 2026", async () => {
    const resolved = await withVenue(pool, { venueId: v.venueA }, (c) =>
      rulePackFor(c, "us-ny-new-york-county", Temporal.PlainDate.from("2026-09-25")),
    );
    expect(resolved?.version).toBe("2026.09");
    expect(resolved?.pack.alcohol.lastSale).toBe("04:00");
  });

  it("a version effective Sat Sep 26 isn't used at 4:00 AM on Sat Sep 26 (business date Sep 25), and is used from 6:00 AM", async () => {
    const next = {
      ...newYorkCounty,
      version: "2026.10",
      alcohol: { ...newYorkCounty.alcohol, lastSale: "03:00" },
    };
    await publishRulePack(owner, {
      pack: next,
      effectiveOn: "2026-09-26",
      approvedBy: ["Abhishek Gaire", "Claude Code"],
      privateKeyPem: key.privateKeyPem,
    });
    const at4am = await withVenue(pool, { venueId: v.venueA }, (c) =>
      rulePackFor(c, "us-ny-new-york-county", dateAt("2026-09-26T08:00:00Z")),
    );
    expect(at4am?.version).toBe("2026.09");
    const at6am = await withVenue(pool, { venueId: v.venueA }, (c) =>
      rulePackFor(c, "us-ny-new-york-county", dateAt("2026-09-26T10:00:00Z")),
    );
    expect(at6am?.version).toBe("2026.10");
    expect(at6am?.pack.alcohol.lastSale).toBe("03:00");
    const versions = await withVenue(pool, { venueId: v.venueA }, (c) =>
      rulePackVersions(c, "us-ny-new-york-county"),
    );
    expect(versions.map((x) => [x.version, x.effectiveOn])).toEqual([
      ["2026.09", "2026-09-01"],
      ["2026.10", "2026-09-26"],
    ]);
  });

  it("a version with a bad signature, or with fewer than two approvers, is never used", async () => {
    const bad = {
      ...newYorkCounty,
      version: "2026.11",
      salesTax: { ...newYorkCounty.salesTax, rate: 0.01 },
    };
    const keyId = (
      await owner.query<{ key_id: string }>("select key_id from rule_pack_signing_keys limit 1")
    ).rows[0]!.key_id;
    // Signed over different data than stored.
    await owner.query(
      "insert into rule_packs (id, version, effective_on, data, approved_by, signature, key_id) values ($1, $2, '2026-10-01', $3, $4, $5, $6)",
      [
        bad.id,
        bad.version,
        JSON.stringify(bad),
        ["Abhishek Gaire", "Claude Code"],
        signRulePack(newYorkCounty, key.privateKeyPem),
        keyId,
      ],
    );
    // Correctly signed but with one approver (listed twice).
    const one = { ...newYorkCounty, version: "2026.12" };
    await owner.query(
      "insert into rule_packs (id, version, effective_on, data, approved_by, signature, key_id) values ($1, $2, '2026-10-01', $3, $4, $5, $6)",
      [
        one.id,
        one.version,
        JSON.stringify(one),
        ["Abhishek Gaire", "Abhishek Gaire"],
        signRulePack(one, key.privateKeyPem),
        keyId,
      ],
    );
    const resolved = await withVenue(pool, { venueId: v.venueA }, (c) =>
      rulePackFor(c, "us-ny-new-york-county", Temporal.PlainDate.from("2026-12-01")),
    );
    expect(resolved?.version).toBe("2026.10");
    await expect(
      publishRulePack(owner, {
        pack: one,
        effectiveOn: "2026-10-01",
        approvedBy: ["Only One"],
        privateKeyPem: key.privateKeyPem,
      }),
    ).rejects.toThrow(/two named approvers/);
  });

  it("a retired key's versions stop being used", async () => {
    await owner.query("update rule_pack_signing_keys set retired_at = now()");
    const resolved = await withVenue(pool, { venueId: v.venueA }, (c) =>
      rulePackFor(c, "us-ny-new-york-county", Temporal.PlainDate.from("2026-09-25")),
    );
    expect(resolved).toBeNull();
    await owner.query("update rule_pack_signing_keys set retired_at = null");
  });

  it("app_rw can't insert or update rule_packs", async () => {
    await expect(
      withVenue(pool, { venueId: v.venueA }, (c) =>
        c.query("update rule_packs set effective_on = '2020-01-01'"),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withVenue(pool, { venueId: v.venueA }, (c) =>
        c.query(
          "insert into rule_packs (id, version, effective_on, data, approved_by, signature, key_id) values ('x', '1', '2026-01-01', '{}', '{}', 'x', 'x')",
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withVenue(pool, { venueId: v.venueA }, (c) =>
        c.query("insert into rule_pack_signing_keys (key_id, public_key) values ('x', 'x')"),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
