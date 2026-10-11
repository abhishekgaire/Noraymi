import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
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
 * The venue age policy (D108; spec 03 · safety.allAgesUntil): "21 and over" (West 4, the default)
 * or "All ages until [time], then 21 and over" (Sing Sing, 8:00 PM, per its website). Set in Admin
 * → Safety by an owner or manager; the website, the booking page and a booking that runs past the
 * switch say it, and the board shows "21+ from 8:00 PM" at the switch for half an hour. The alcohol
 * rules don't change with it. Over the demo seed, as West 4 trying Sing Sing's policy.
 */
let db: TestDatabase;
let owner: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
let who: Principal | undefined;
let token = "";
const clock = new SimulatedClock(SEED_NOW);
const as = (slug: string, role: string, session: "passkey" | "pin" = "passkey") => {
  who = {
    kind: "user",
    userId: ids[slug]!,
    session,
    memberships: [{ venueId, membershipId: ids[`${slug}.membership`]!, role } as never],
  };
};
const call = (method: "GET" | "PUT", path: string, payload?: object) =>
  api.inject({
    method,
    url: `/v1/venues/${venueId}${path}`,
    ...(payload ? { payload } : {}),
  });
const safety = async () =>
  (await call("GET", "/settings/safety")).json() as {
    value: { occupancyLimit: number | null; warnAtPct: number; allAgesUntil?: string | null };
  };
const setPolicy = async (allAgesUntil: string | null) => {
  as("abhishek", "owner");
  const now = (await safety()).value;
  const r = await call("PUT", "/settings/safety", { value: { ...now, allAgesUntil } });
  expect(r.statusCode, r.body).toBe(200);
};
const ageAlerts = async () => {
  as("maya", "bartender", "pin");
  const r = await call("GET", "/board");
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as { alerts: { kind: string; color: string; at?: string }[] }).alerts.filter(
    (a) => a.kind === "age",
  );
};
const site = async () =>
  (await api.inject({ method: "GET", url: "/v1/public/venues/west4karaoke/site" })).json() as {
    age: { all_ages_until: string | null };
  };
const manage = async () =>
  (await api.inject({ method: "GET", url: `/v1/public/bookings/${token}` })).json().manage as {
    starts_at: string;
    ends_at: string;
    age_21_from: string | null;
  };
const wall = (iso: string) => {
  const z = Temporal.Instant.from(iso).toZonedDateTimeISO("America/New_York");
  return `${String(z.hour).padStart(2, "0")}:${String(z.minute).padStart(2, "0")}`;
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
  token = randomBytes(16).toString("base64url");
  await owner.query("update bookings set manage_token_hash = $2 where id = $1", [
    ids["bk_jae"],
    createHash("sha256").update(token).digest("hex"),
  ]);
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    moduleCacheMs: 0,
    authenticators: [async (r) => (r.url.startsWith("/v1/venues/") ? who : undefined)],
  });
  await api.ready();
});

afterAll(async () => {
  await api?.close();
  await owner?.end();
  await db?.drop();
});

describe("the venue age policy (D108)", () => {
  it("West 4 is 21 and over: no switch on the site, no note on a booking, no board alert", async () => {
    as("abhishek", "owner");
    expect((await safety()).value.allAgesUntil ?? null).toBeNull();
    expect((await site()).age).toEqual({ all_ages_until: null });
    expect((await manage()).age_21_from).toBeNull();
    clock.set(Temporal.Instant.from("2026-09-26T00:05:00Z")); // 8:05 PM
    expect(await ageAlerts()).toEqual([]);
  });

  it("a bartender can't set it; a time that isn't one is refused", async () => {
    as("maya", "bartender", "pin");
    const now = (await safety()).value;
    const r = await call("PUT", "/settings/safety", { value: { ...now, allAgesUntil: "20:00" } });
    expect(r.statusCode).toBe(403);
    as("abhishek", "owner");
    const bad = await call("PUT", "/settings/safety", { value: { ...now, allAgesUntil: "8 PM" } });
    expect(bad.statusCode).toBe(400);
  });

  it("all ages until 8:00 PM: the site says it, and the board shows the switch for half an hour", async () => {
    await setPolicy("20:00");
    expect((await site()).age).toEqual({ all_ages_until: "20:00" });
    clock.set(Temporal.Instant.from("2026-09-25T23:59:00Z")); // 7:59 PM
    expect(await ageAlerts()).toEqual([]);
    clock.set(Temporal.Instant.from("2026-09-26T00:00:00Z")); // 8:00 PM
    expect(await ageAlerts()).toEqual([
      expect.objectContaining({ kind: "age", color: "amber", at: "2026-09-26T00:00:00Z" }),
    ]);
    clock.set(Temporal.Instant.from("2026-09-26T00:31:00Z")); // 8:31 PM
    expect(await ageAlerts()).toEqual([]);
  });

  it("the booking page states it, and a booking that runs past the switch says when", async () => {
    clock.set(SEED_NOW);
    const avail = await api.inject({
      method: "GET",
      url: "/v1/public/venues/west4karaoke/availability?guests=4&hours=2&date=2026-09-27",
    });
    expect(avail.statusCode, avail.body).toBe(200);
    expect(avail.json().all_ages_until).toBe("20:00");

    // Jae's booking: the switch an hour after it starts, so it runs past it.
    const b = await manage();
    const start = Temporal.Instant.from(b.starts_at);
    await setPolicy(wall(start.add({ hours: 1 }).toString()));
    expect((await manage()).age_21_from).toBe(start.add({ hours: 1 }).toString());
    // The switch at its end: over before 21 and over starts, so no note.
    await setPolicy(wall(b.ends_at));
    expect((await manage()).age_21_from).toBeNull();
    await setPolicy(null);
  });
});
