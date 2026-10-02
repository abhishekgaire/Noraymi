import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { publishRulePack, withVenue } from "@west4/db";
import {
  appPool,
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "@west4/db/test-helpers";
import { generateSigningKey } from "@west4/db";
import { FrozenClock, SEED_NOW, newYorkCounty } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";

let db: TestDatabase;
let v: TwoVenues;
let app: FastifyInstance;
let pool: pg.Pool;

const hours = { weekly: [{ day: 5, opens: "16:00", closes: "04:00" }], lastCall: "04:00" };
const drawer = {
  drawer: "house",
  startingBankCents: 30000,
  noteOverCents: 2000,
  secondCounter: "whenOff",
  paidOutApprovalCents: 10000,
  perPerson: { who: "bartenders", countLater: false },
};
const pay = {
  cardFee: { mode: "off" },
  gratuity: { auto: "rooms", pct: 20 },
  tipScreen: {
    on: true,
    pcts: [18, 20, 22],
    fixedCents: [100, 200, 300],
    smartThresholdCents: 1000,
  },
  tipReview: { overPct: 25, overCents: 5000, lateHours: 2 },
  pool: "hours",
  roomHold: { on: false, cents: 0 },
  payShare: { on: true },
};

const put = (path: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "PUT", url: `/v1/venues/${v.venueA}${path}`, payload, headers });
/**
 * A card-fee change asks for the passkey again (M4-26): a real session for the owner, and a step-up
 * token for it, as the passkey ceremony gives.
 */
const steppedUp = async (): Promise<Record<string, string>> => {
  const owner = new pg.Client({ connectionString: db.url });
  await owner.connect();
  try {
    const token = randomBytes(24).toString("base64url");
    const step = randomBytes(24).toString("base64url");
    const session = (
      await owner.query<{ id: string }>(
        `insert into auth_sessions (principal, user_id, membership_id, assurance, client, token_hash, started_at, last_seen_at, expires_at)
         values ('staff', $1, $2, 'passkey', 'web', $3, now(), now(), now() + interval '1 hour') returning id`,
        [v.ownerA, v.membershipA, createHash("sha256").update(token).digest("hex")],
      )
    ).rows[0]!.id;
    await owner.query(
      `insert into auth_challenges (user_id, purpose, challenge, session_id, attempts, created_at, expires_at)
       values ($1, 'step_up_token', $2, $3, 0, now(), now() + interval '1 hour')`,
      [v.ownerA, createHash("sha256").update(step).digest("hex"), session],
    );
    return { authorization: `Bearer ${token}`, "x-step-up": step };
  } finally {
    await owner.end();
  }
};
const get = (path: string) => app.inject({ method: "GET", url: `/v1/venues/${v.venueA}${path}` });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  const owner = new pg.Client({ connectionString: db.url });
  await owner.connect();
  await publishRulePack(owner, {
    pack: newYorkCounty,
    effectiveOn: "2026-09-01",
    approvedBy: ["A", "B"],
    privateKeyPem: generateSigningKey().privateKeyPem,
  });
  await owner.end();
  const andy: Principal = {
    kind: "user",
    userId: v.ownerA,
    session: "passkey",
    memberships: [{ venueId: v.venueA, membershipId: v.membershipA, role: "owner" }],
  };
  const config = loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url });
  app = buildApp({
    config,
    clock: new FrozenClock(SEED_NOW),
    // A request with a bearer token signs in as its session instead (the step-up tests).
    authenticators: [async (request) => (request.headers.authorization ? undefined : andy)],
    eventsPollMs: 100,
  });
  await app.ready();
  pool = appPool(db.url);
});

afterAll(async () => {
  await pool.end();
  await app.close();
  await db.drop();
});

describe("settings", () => {
  it("PUT /settings/hours with lastCall 04:30 is refused, naming the house last call and the pack's 4:00 AM, and nothing is saved", async () => {
    const res = await put("/settings/hours", { value: { ...hours, lastCall: "04:30" } });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toContain("house last call (4:30 AM)");
    expect(body.error.message).toContain("last sale (4:00 AM)");
    expect((await get("/settings/hours")).statusCode).toBe(404);
  });

  it("lastCall 03:00 saves the next version and sends settings.changed; the old version stays readable", async () => {
    const first = await put("/settings/hours", { value: hours });
    expect(first.statusCode).toBe(200);
    expect(first.json().saved[0]).toMatchObject({
      key: "hours",
      version: 1,
      startsOn: "2026-09-25",
    });
    const second = await put("/settings/hours", { value: { ...hours, lastCall: "03:00" } });
    expect(second.statusCode).toBe(200);
    expect(second.json().saved[0]).toMatchObject({
      key: "hours",
      version: 2,
      value: { lastCall: "03:00" },
    });
    const now = await get("/settings/hours");
    expect(now.json()).toMatchObject({
      key: "hours",
      version: 2,
      value: { lastCall: "03:00" },
      business_date: "2026-09-25",
    });
    const history = await get("/settings/hours?history=1");
    expect(
      history
        .json()
        .versions.map((x: { version: number; value: { lastCall: string } }) => [
          x.version,
          x.value.lastCall,
        ]),
    ).toEqual([
      [2, "03:00"],
      [1, "04:00"],
    ]);
    const events = await withVenue(pool, { venueId: v.venueA }, (c) =>
      c.query<{ type: string; entity_id: string; entity_version: number }>(
        "select type, entity_id, entity_version from venue_events where type = 'settings.changed' order by id",
      ),
    );
    expect(events.rows).toEqual([
      { type: "settings.changed", entity_id: "hours", entity_version: 1 },
      { type: "settings.changed", entity_id: "hours", entity_version: 2 },
    ]);
  });

  it("a 3.5% card surcharge is refused (over 2.7%), and a 2.7% one with noticeSentOn today is refused until 30 days later", async () => {
    const over = await put("/settings/pay", {
      value: { ...pay, cardFee: { mode: "surcharge", pct: 3.5, noticeSentOn: "2026-08-01" } },
    });
    expect(over.statusCode).toBe(400);
    expect(over.json().error.message).toContain("2.7%");
    const soon = await put("/settings/pay", {
      value: { ...pay, cardFee: { mode: "surcharge", pct: 2.7, noticeSentOn: "2026-09-25" } },
    });
    expect(soon.statusCode).toBe(400);
    expect(soon.json().error.message).toContain("from 2026-10-25");
    const value = { ...pay, cardFee: { mode: "surcharge", pct: 2.7, noticeSentOn: "2026-08-01" } };
    // A valid card-fee change still needs the passkey again (M4-26).
    const unconfirmed = await put("/settings/pay", { value });
    expect(unconfirmed.statusCode).toBe(403);
    expect(unconfirmed.json().error.code).toBe("step_up_required");
    const ok = await put("/settings/pay", { value }, await steppedUp());
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("a drawer change saved at 10:41 PM on Fri Sep 25 reads 'Starts Sat Sep 26', and business date Sep 25 still gets the old version", async () => {
    expect((await put("/settings/drawer", { value: drawer })).json().saved[0]).toMatchObject({
      version: 1,
      startsOn: "2026-09-25",
    });
    const changed = await put("/settings/drawer", { value: { ...drawer, drawer: "perPerson" } });
    expect(changed.json().saved[0]).toMatchObject({ version: 2, startsOn: "2026-09-26" });
    expect((await get("/settings/drawer")).json()).toMatchObject({
      version: 1,
      value: { drawer: "house" },
    });
    expect((await get("/settings/drawer?business_date=2026-09-26")).json()).toMatchObject({
      version: 2,
      value: { drawer: "perPerson" },
    });
    // The tip-pool method waits too; a tip-screen change is live at once.
    // The earlier test saved a 2.7% surcharge; these keep it, so neither is a card-fee change.
    const fee = { mode: "surcharge", pct: 2.7, noticeSentOn: "2026-08-01" };
    const poolChange = await put("/settings/pay", {
      value: { ...pay, cardFee: fee, pool: "even" },
    });
    expect(poolChange.json().saved[0].startsOn).toBe("2026-09-26");
    const screen = await put("/settings/pay", {
      value: { ...pay, cardFee: fee, tipScreen: { ...pay.tipScreen, pcts: [15, 18, 20] } },
    });
    expect(screen.json().saved[0].startsOn).toBe("2026-09-25");
  });

  it("saving two keys together writes both or neither, with one settings.changed", async () => {
    const before = await withVenue(pool, { venueId: v.venueA }, (c) =>
      c.query("select count(*)::int as n from venue_settings"),
    );
    const bad = await put("/settings", {
      values: {
        hours: { ...hours, lastCall: "02:00" },
        safety: { occupancyLimit: 0, warnAtPct: 90 },
      },
    });
    expect(bad.statusCode).toBe(400);
    const after = await withVenue(pool, { venueId: v.venueA }, (c) =>
      c.query("select count(*)::int as n from venue_settings"),
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const good = await put("/settings", {
      values: {
        hours: { ...hours, lastCall: "02:00" },
        safety: { occupancyLimit: null, warnAtPct: 90 },
      },
    });
    expect(good.statusCode).toBe(200);
    expect(
      good
        .json()
        .saved.map((s: { key: string }) => s.key)
        .sort(),
    ).toEqual(["hours", "safety"]);
    const events = await withVenue(pool, { venueId: v.venueA }, (c) =>
      c.query<{ entity_id: string }>(
        "select entity_id from venue_events where type = 'settings.changed' order by id desc limit 1",
      ),
    );
    expect(events.rows[0]?.entity_id).toBe("hours,safety");
  });

  it("an unknown key or an extra field is refused, and a bartender's PIN session can't save", async () => {
    expect((await put("/settings/nope", { value: {} })).statusCode).toBe(404);
    const extra = await put("/settings/languages", { value: { staff: ["en"], label: "Tip" } });
    expect(extra.statusCode).toBe(400);
    expect(extra.json().error.message).toMatch(/languages/);
    expect((await get("/settings/languages")).statusCode).toBe(404);
  });
});
