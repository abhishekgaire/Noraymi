import { createHash } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

/** Admin → Deposits & cancelling and the policy guests accept (M5-06). */
let db: TestDatabase;
let owner: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
let who: Principal | undefined;
const call = (method: "GET" | "PUT", path: string, payload?: object) =>
  api.inject({ method, url: `/v1/venues/${venueId}${path}`, ...(payload ? { payload } : {}) });
const policy = async () =>
  (await api.inject({ method: "GET", url: "/v1/public/venues/west4karaoke/policy" })).json();
const versions = async () =>
  (await owner.query("select count(*)::int as n from policy_versions")).rows[0].n as number;

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
  who = {
    kind: "user",
    userId: ids["abhishek"]!,
    session: "passkey",
    memberships: [{ venueId, membershipId: ids["abhishek.membership"]!, role: "owner" } as never],
  };
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock: new FrozenClock(SEED_NOW),
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

describe("the deposit policy", () => {
  it("West 4: the first hour, 24 hours, keep, keep, 15 minutes and $250 from 20, as policy version 1", async () => {
    const deposit = (await call("GET", "/settings/deposit")).json().value;
    expect(deposit).toEqual({
      on: true,
      mode: "firstHour",
      value: 0,
      refundHours: 24,
      late: "keep",
      noShow: "keep",
      graceMin: 15,
      bigParty: { fromGuests: 20, deposit: { kind: "flat", cents: 25000 }, refundHours: 24 },
    });
    const p = await policy();
    expect(p.version).toBe(1);
    expect(p.text).toContain("We save the card you pay with.");
    expect(p.text).toContain("Cancel at least 24 hours before your start for a full refund.");
    expect(p.text).toContain("A 20% gratuity is added to room tabs.");
    expect(p.hash).toBe(createHash("sha256").update(p.text).digest("hex"));
  });

  it("a save writes the next version, and a booking made before keeps the one it accepted", async () => {
    const v1 = await policy();
    await owner.query(
      "update bookings set policy_version_id = $1 where id = (select id from bookings order by starts_at limit 1)",
      [v1.id],
    );
    const deposit = (await call("GET", "/settings/deposit")).json().value;
    const saved = await call("PUT", "/settings/deposit", {
      value: { ...deposit, refundHours: 48, noShow: "firstHour" },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().policy_version).toBe(2);
    const v2 = await policy();
    expect(v2.version).toBe(2);
    expect(v2.text).toContain("at least 48 hours");
    expect(v2.text).toContain("we charge the saved card up to the first hour's room time in total");
    const kept = await owner.query(
      "select count(*)::int as n from bookings where policy_version_id = $1",
      [v1.id],
    );
    expect(kept.rows[0].n).toBe(1);
    const list = (await call("GET", "/policy-versions")).json().versions;
    expect(list.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(list[0].published_by).toMatch(/^Abhishek/);
  });

  it("the same words make no new version; a refused deposit saves nothing", async () => {
    const before = await versions();
    const pay = (await call("GET", "/settings/pay")).json().value;
    expect((await call("PUT", "/settings/pay", { value: pay })).statusCode).toBe(200);
    expect(await versions()).toBe(before);
    const deposit = (await call("GET", "/settings/deposit")).json().value;
    const bad = await call("PUT", "/settings/deposit", {
      value: { ...deposit, mode: "percent", value: 120 },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toMatch(/whole percent from 1 to 100/);
    expect(await versions()).toBe(before);
  });
});
