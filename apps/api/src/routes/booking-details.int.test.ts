import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  generateSigningKey,
  loadDemoSeed,
  payTokenHash,
  publishRulePack,
  withVenue,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, newYorkCounty } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { acceptTerms } from "../bookings/online.js";

/** The booking's Details and Terms steps (M5-08): the guest, the marketing box and its proof, the policy accepted. */
let db: TestDatabase;
let owner: pg.Pool;
let pool: pg.Pool;
let api: FastifyInstance;
let venueId: string;
const clock = new SimulatedClock(SEED_NOW);
const jae = { business_date: "2026-10-02", time: "23:00", hours: 2, party_size: 5 };
const details = {
  name: "Jae K.",
  phone: "+12125550188",
  email: "jae@example.com",
  marketing: false,
};

const hold = async (body: object = jae) => {
  const r = await api.inject({
    method: "POST",
    url: "/v1/public/venues/west4karaoke/bookings",
    payload: body,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json<{ token: string; booking: { id: string } }>();
};
const give = (token: string, payload: object) =>
  api.inject({
    method: "POST",
    url: `/v1/public/bookings/${token}/details`,
    payload,
    headers: { "x-forwarded-for": "203.0.113.9" },
  });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } });
  owner = new pg.Pool({ connectionString: db.url });
  await publishRulePack(owner, {
    pack: newYorkCounty,
    effectiveOn: "2026-09-01",
    approvedBy: ["A", "B"],
    privateKeyPem: generateSigningKey().privateKeyPem,
  });
  venueId = (await owner.query<{ id: string }>("select id from venues where slug = 'west4karaoke'"))
    .rows[0]!.id;
  pool = appPool(db.url);
  // One proxy in front of the API, as behind the guest site's /v1 rewrite.
  process.env["TRUSTED_PROXY_HOPS"] = "1";
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    moduleCacheMs: 0,
  });
  await api.ready();
});

afterAll(async () => {
  delete process.env["TRUSTED_PROXY_HOPS"];
  await api.close();
  await pool.end();
  await owner.end();
  await db.drop();
});

describe("Details", () => {
  it("a number outside +1 is refused", async () => {
    const { token } = await hold();
    for (const phone of ["+442071234567", "2125550188", "+1212555018"]) {
      const r = await give(token, { ...details, phone });
      expect(r.statusCode).toBe(400);
      expect(r.json().error.details).toMatchObject({ reason: "phone" });
    }
  });

  it("saves the guest for the venue, matched by phone, and an unticked box stores no consent", async () => {
    const first = await hold();
    const r = await give(first.token, details);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().guest).toEqual({
      name: "Jae K.",
      phone: "+12125550188",
      email: "jae@example.com",
    });
    // Marketing texts is off at West 4: no box on the page.
    expect(r.json().marketing_box).toBeNull();
    const second = await hold({ ...jae, time: "21:00" });
    await give(second.token, { ...details, name: "Jae" });
    const guests = await owner.query<{ guest_id: string; name: string }>(
      `select b.guest_id, g.name from bookings b join guests g on g.id = b.guest_id
        where b.id = any($1::uuid[])`,
      [[first.booking.id, second.booking.id]],
    );
    expect(new Set(guests.rows.map((g) => g.guest_id)).size).toBe(1);
    // A returning guest keeps the name they first gave.
    expect(guests.rows.every((g) => g.name === "Jae K.")).toBe(true);
    const consents = await owner.query(
      "select 1 from consents where venue_id = $1 and phone_e164 = $2 and kind = 'marketing'",
      [venueId, details.phone],
    );
    expect(consents.rowCount).toBe(0);
  });

  it("with Marketing texts on, the box starts unticked; ticked, it stores the wording's version, the IP and the time", async () => {
    await owner.query(
      "update venue_modules set state = 'on' where venue_id = $1 and module_id = 'marketing_texts'",
      [venueId],
    );
    try {
      const { token } = await hold({ ...jae, time: "22:00" });
      const page = (
        await api.inject({ method: "GET", url: `/v1/public/bookings/${token}/hold` })
      ).json();
      expect(page.marketing_box.text).toContain("Optional, and not needed for this booking");
      const phone = "+13475550142";
      expect((await give(token, { ...details, phone, marketing: true })).statusCode).toBe(200);
      // Saving again doesn't write the same proof twice.
      expect((await give(token, { ...details, phone, marketing: true })).statusCode).toBe(200);
      const rows = await owner.query<{
        channel: string;
        kind: string;
        source: string;
        text_version: string;
        ip: string;
        given_at: Date;
        words: string;
        pv_kind: string;
      }>(
        `select k.channel, k.kind, k.source, k.text_version, host(k.ip) as ip, k.given_at, p.text as words, p.kind as pv_kind
           from consents k join policy_versions p on p.id::text = k.text_version
          where k.venue_id = $1 and k.phone_e164 = $2`,
        [venueId, phone],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({
        channel: "sms",
        kind: "marketing",
        source: "booking_form",
        text_version: page.marketing_box.id,
        ip: "203.0.113.9",
        words: page.marketing_box.text,
        pv_kind: "marketing_opt_in",
      });
      expect(
        Math.abs(rows.rows[0]!.given_at.getTime() - clock.now().epochMilliseconds),
      ).toBeLessThan(5000);
    } finally {
      await owner.query(
        "update venue_modules set state = 'off' where venue_id = $1 and module_id = 'marketing_texts'",
        [venueId],
      );
    }
  });

  it("a lapsed hold takes no details", async () => {
    const { token } = await hold({ ...jae, time: "23:30" });
    clock.set(clock.now().add({ minutes: 11 }));
    try {
      const r = await give(token, details);
      expect(r.statusCode).toBe(400);
      expect(r.json().error.details).toMatchObject({ reason: "hold_over" });
    } finally {
      clock.set(SEED_NOW);
    }
  });
});

describe("Terms", () => {
  it("the hold shows the current policy and this booking's cut-off; accepting stores the version, time, IP and browser", async () => {
    const { token, booking } = await hold({ ...jae, time: "20:00" });
    const page = (
      await api.inject({ method: "GET", url: `/v1/public/bookings/${token}/hold` })
    ).json();
    expect(page.policy.text).toContain("A 20% gratuity is added to room tabs.");
    // Fri Oct 2, 8:00 PM less 24 hours, seen from Fri Sep 25: within six days, so the weekday alone.
    expect(page.cutoff_words).toBe("Thu 8:00 PM");
    const at = clock.now();
    const run = (policyVersionId: string) =>
      withVenue(pool, { venueId, requestId: "t" }, (c) =>
        acceptTerms(c, venueId, booking.id, {
          policyVersionId,
          ip: "203.0.113.9",
          userAgent: "Mozilla/5.0 (iPhone)",
          at,
        }),
      );
    // Before the details, there's no one to accept.
    await expect(run(page.policy.id)).rejects.toMatchObject({ details: { reason: "details" } });
    await give(token, details);
    await expect(run("00000000-0000-4000-8000-000000000001")).rejects.toMatchObject({
      details: { reason: "policy_changed" },
    });
    expect(await run(page.policy.id)).toEqual({
      policy_version_id: page.policy.id,
      hash: page.policy.hash,
    });
    const row = await owner.query(
      `select b.policy_version_id, p.hash, b.accepted_at, host(b.accepted_ip) as ip, b.accepted_ua
         from bookings b join policy_versions p on p.id = b.policy_version_id
        where b.manage_token_hash = $1`,
      [payTokenHash(token)],
    );
    expect(row.rows[0]).toMatchObject({
      policy_version_id: page.policy.id,
      hash: page.policy.hash,
      ip: "203.0.113.9",
      accepted_ua: "Mozilla/5.0 (iPhone)",
    });
    expect(Math.abs(row.rows[0].accepted_at.getTime() - at.epochMilliseconds)).toBeLessThan(1);
  });
});
