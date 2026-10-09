import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Worker, generateSigningKey, publishRulePack } from "@west4/db";
import {
  appPool,
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, Temporal, newYorkCounty } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { GoogleClient } from "../google/client.js";
import { FakeGoogle } from "../google/fake.js";
import { GOOGLE_PUSH_KIND, makeGooglePushHandler } from "../google/profile.js";
import { fakeGoogleSettings } from "../google/settings.js";

/**
 * M5-15: Google Business Profile against the fake Google, which speaks the
 * same HTTP as Google's OAuth and Business Information APIs (a recorded
 * contract while API access is pending): connect, push the weekly hours and
 * closures, a failed push shown and retried, and nothing at all before
 * connecting or after disconnecting.
 */
let db: TestDatabase;
let v: TwoVenues;
let owner: pg.Pool;
let pool: pg.Pool;
let app: FastifyInstance;
let fake: FakeGoogle;
let google: GoogleClient;
let worker: Worker;
const clock = new FrozenClock(SEED_NOW);
const weekly = [0, 1, 2, 3, 4, 5, 6].map((day) => ({
  day,
  opens: day === 0 || day === 6 ? "14:00" : "16:00",
  closes: "04:00",
}));
const base = (venueId = v.venueA) => `/v1/venues/${venueId}/connections/google`;

async function queued(venueId: string): Promise<number> {
  const r = await owner.query<{ n: number }>(
    "select count(*)::int as n from jobs where venue_id = $1 and kind = $2 and status = 'queued'",
    [venueId, GOOGLE_PUSH_KIND],
  );
  return r.rows[0]!.n;
}

const friday = () =>
  (
    fake.locations.get("locations/fake-west4")!.regularHours as {
      periods: { openDay: string; openTime: { hours: number } }[];
    }
  ).periods.find((p) => p.openDay === "FRIDAY");

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  owner = new pg.Pool({ connectionString: db.url });
  pool = appPool(db.url);
  const c = await owner.connect();
  await publishRulePack(c, {
    pack: newYorkCounty,
    effectiveOn: "2026-09-01",
    approvedBy: ["A", "B"],
    privateKeyPem: generateSigningKey().privateKeyPem,
  });
  c.release();
  fake = new FakeGoogle();
  google = new GoogleClient(fakeGoogleSettings(await fake.start()));
  const andy: Principal = {
    kind: "user",
    userId: v.ownerA,
    session: "passkey",
    memberships: [{ venueId: v.venueA, membershipId: v.membershipA, role: "owner" }],
  };
  const config = loadConfig({
    WEST4_ENV: "local",
    DATABASE_URL: db.url,
    APP_DATABASE_URL: db.url,
    STAFF_APP_URL: "http://localhost:5173",
  });
  app = buildApp({ config, clock, google, authenticators: [async () => andy] });
  await app.ready();
  worker = new Worker(pool, {
    pool: "normal",
    handlers: { [GOOGLE_PUSH_KIND]: makeGooglePushHandler(google, config.auth.secretKey) },
    clock,
    random: () => 0.5,
  });
  await app.inject({
    method: "PUT",
    url: `/v1/venues/${v.venueA}/settings/hours`,
    payload: { value: { weekly, lastCall: "04:00" } },
  });
});

afterAll(async () => {
  await app.close();
  await fake.stop();
  await pool.end();
  await owner.end();
  await db.drop();
});

describe("Google Business Profile (M5-15)", () => {
  it("before connecting: Admin shows Google as not connected and no job runs", async () => {
    const list = await app.inject({ method: "GET", url: `/v1/venues/${v.venueA}/connections` });
    expect(list.json().connections).toContainEqual(
      expect.objectContaining({ kind: "google", status: "not_connected" }),
    );
    const g = await app.inject({ method: "GET", url: base() });
    expect(g.json()).toMatchObject({ available: true, status: "not_connected", last_push: null });
    await app.inject({
      method: "POST",
      url: `/v1/venues/${v.venueA}/closures`,
      payload: { date: "2026-11-26", kind: "closed" },
    });
    expect(await queued(v.venueA)).toBe(0);
    expect((await app.inject({ method: "POST", url: `${base()}/push` })).statusCode).toBe(404);
    expect(fake.patches).toHaveLength(0);
  });

  it("refuses a callback whose state isn't this venue's", async () => {
    const r = await app.inject({
      method: "POST",
      url: `${base()}/callback`,
      payload: { code: fake.issueCode(), state: "forged.state" },
    });
    expect(r.statusCode).toBe(400);
  });

  it("connects through Google's consent and pushes the weekly hours and closures", async () => {
    const start = await app.inject({ method: "POST", url: `${base()}/connect` });
    const url = new URL(start.json().url as string);
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/business.manage");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:5173/admin/connections");
    // Google's consent screen sends the browser back to Admin → Connections with a code.
    const consent = await fetch(url, { redirect: "manual" });
    const back = new URL(consent.headers.get("location")!);
    const cb = await app.inject({
      method: "POST",
      url: `${base()}/callback`,
      payload: { code: back.searchParams.get("code"), state: back.searchParams.get("state") },
    });
    expect(cb.statusCode).toBe(200);
    expect(cb.json()).toMatchObject({
      status: "connected",
      location: { name: "locations/fake-west4" },
    });
    // The token is kept encrypted, never as Google sent it.
    const row = await owner.query<{ config: Record<string, string> }>(
      "select config from integrations where venue_id = $1 and kind = 'google'",
      [v.venueA],
    );
    expect(row.rows[0]!.config["refresh_enc"]).not.toContain("fake-refresh");

    expect(await queued(v.venueA)).toBe(1);
    expect(await worker.tick()).toBe(1);
    expect(friday()).toMatchObject({
      openTime: { hours: 16, minutes: 0 },
      closeDay: "SATURDAY",
      closeTime: { hours: 4, minutes: 0 },
    });
    expect(fake.locations.get("locations/fake-west4")!.specialHours).toEqual({
      specialHourPeriods: [{ startDate: { year: 2026, month: 11, day: 26 }, closed: true }],
    });
    const g = await app.inject({ method: "GET", url: base() });
    expect(g.json().last_push).toMatchObject({ status: "ok" });
  });

  it("changing Friday's hours updates the regular hours; a closed date adds a special-hours entry", async () => {
    await app.inject({
      method: "PUT",
      url: `/v1/venues/${v.venueA}/settings/hours`,
      payload: {
        value: {
          weekly: weekly.map((w) => (w.day === 5 ? { ...w, opens: "18:00" } : w)),
          lastCall: "04:00",
        },
      },
    });
    expect(await queued(v.venueA)).toBe(1);
    expect(await worker.tick()).toBe(1);
    expect(friday()).toMatchObject({ openTime: { hours: 18, minutes: 0 } });

    await app.inject({
      method: "POST",
      url: `/v1/venues/${v.venueA}/closures`,
      payload: { date: "2026-12-25", kind: "closed" },
    });
    expect(await worker.tick()).toBe(1);
    expect(
      (
        fake.locations.get("locations/fake-west4")!.specialHours as {
          specialHourPeriods: unknown[];
        }
      ).specialHourPeriods,
    ).toContainEqual({ startDate: { year: 2026, month: 12, day: 25 }, closed: true });
  });

  it("a failed push shows in Admin → Connections and retries", async () => {
    fake.failNext = 1;
    expect((await app.inject({ method: "POST", url: `${base()}/push` })).statusCode).toBe(200);
    expect(await worker.tick()).toBe(1);
    const failed = await app.inject({ method: "GET", url: base() });
    expect(failed.json().last_push).toMatchObject({ status: "failed" });
    expect(failed.json().last_push.error).toContain("503");
    const job = await owner.query<{ attempts: number; run_at: Date }>(
      "select attempts, run_at from jobs where venue_id = $1 and kind = $2 and status = 'queued'",
      [v.venueA, GOOGLE_PUSH_KIND],
    );
    expect(job.rows[0]!.attempts).toBe(1);
    clock.advance(
      Temporal.Duration.from({
        milliseconds: job.rows[0]!.run_at.getTime() - clock.now().epochMilliseconds + 1,
      }),
    );
    expect(await worker.tick()).toBe(1);
    const ok = await app.inject({ method: "GET", url: base() });
    expect(ok.json().last_push).toMatchObject({ status: "ok" });
  });

  it("stays on its own venue, and nothing pushes once disconnected", async () => {
    // Venue A's connection isn't venue B's.
    const r = await owner.query(
      "select 1 from integrations where venue_id = $1 and kind = 'google'",
      [v.venueB],
    );
    expect(r.rowCount).toBe(0);

    const off = await app.inject({ method: "POST", url: `${base()}/disconnect` });
    expect(off.json()).toMatchObject({ status: "disconnected", location: null });
    const before = fake.patches.length;
    await app.inject({
      method: "POST",
      url: `/v1/venues/${v.venueA}/closures`,
      payload: { date: "2026-12-31", kind: "special", closes: "02:00" },
    });
    expect(await queued(v.venueA)).toBe(0);
    expect(await worker.tick()).toBe(0);
    expect(fake.patches.length).toBe(before);
  });
});
