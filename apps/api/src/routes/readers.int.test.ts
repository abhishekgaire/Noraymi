import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  DEVICE_SILENCE_MS,
  flagQuietDevices,
  generateSigningKey,
  listDevices,
  loadDemoSeed,
  publishRulePack,
  withVenue,
} from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, newYorkCounty } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { sweepReaders } from "../jobs/reader-health.js";
import { StripeClient } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { fakeStripeSettings } from "../stripe/settings.js";

let db: TestDatabase;
let owner: pg.Pool;
let app: FastifyInstance;
let fake: FakeStripe;
let stripe: StripeClient;
let venueId: string;
let ids: Record<string, string>;
let accountId: string;
let otherReader: string;
const clock = new FrozenClock(SEED_NOW);

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
  fake = new FakeStripe();
  stripe = new StripeClient(fakeStripeSettings(await fake.start()));
  const made = await stripe.call<{ id: string }>("payments", "POST", "/v2/core/accounts", {
    account: null,
    platform: true,
    idempotencyKey: "west4-account",
    params: { display_name: "West 4 Boho Karaoke" },
  });
  accountId = made.id;
  await owner.query("update organizations set stripe_account_id = $1", [accountId]);
  // Another organization's venue with a reader of its own.
  const org = (
    await owner.query<{ id: string }>(
      "insert into organizations (legal_name) values ('Other LLC') returning id",
    )
  ).rows[0]!.id;
  const other = (
    await owner.query<{ id: string }>(
      "insert into venues (org_id, name, slug) values ($1, 'Other', 'other-venue') returning id",
      [org],
    )
  ).rows[0]!.id;
  otherReader = (
    await owner.query<{ id: string }>(
      "insert into devices (venue_id, kind, name, stripe_reader_id) values ($1, 'reader', 'Their S710', 'tmr_theirs') returning id",
      [other],
    )
  ).rows[0]!.id;
  const abhishek: Principal = {
    kind: "user",
    userId: ids["abhishek"]!,
    session: "passkey",
    memberships: [{ venueId, membershipId: ids["abhishek.membership"]!, role: "owner" }],
  };
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    stripe,
    moduleCacheMs: 0,
    authenticators: [async () => abhishek],
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await fake.stop();
  await owner.end();
  await db.drop();
});

describe("West 4's card readers", () => {
  it("registers both S710s to West 4's Location, whose configuration has cellular on and the tip choices", async () => {
    for (const label of ["Bar S710", "Front desk S710"]) {
      const r = await app.inject({
        method: "POST",
        url: `/v1/venues/${venueId}/readers`,
        payload: { registration_code: "simulated-s710", label },
        headers: { "idempotency-key": `reader-${label}` },
      });
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json()).toMatchObject({
        label,
        model: "stripe_s710",
        cellular: true,
        monthly_fee_cents: 1000,
      });
    }
    // The seed's own rows were taken over, not duplicated.
    const rows = await owner.query(
      "select id, stripe_reader_id from devices where kind = 'reader' and venue_id = $1 order by name",
      [venueId],
    );
    expect(rows.rows.map((r) => r.id)).toEqual([ids["dev_bar_reader"], ids["dev_front_reader"]]);

    const venue = (
      await owner.query(
        "select stripe_location_id, stripe_terminal_config_id from venues where id = $1",
        [venueId],
      )
    ).rows[0];
    const location = fake.objects.get(venue.stripe_location_id)!;
    expect(location).toMatchObject({
      display_name: "West 4 Boho Karaoke",
      configuration_overrides: venue.stripe_terminal_config_id,
      _account: accountId,
    });
    expect(fake.objects.get(venue.stripe_terminal_config_id)).toMatchObject({
      tipping: {
        usd: {
          percentages: ["18", "20", "22"],
          smart_tip_threshold: "1000",
          fixed_amounts: ["100", "200", "300"],
        },
      },
      cellular: { enabled: "true" },
    });
    const readers = fake.list("terminal.reader", accountId);
    expect(readers.map((r) => [r["label"], r["location"]])).toEqual([
      ["Front desk S710", venue.stripe_location_id],
      ["Bar S710", venue.stripe_location_id],
    ]);
    // One Location and one Configuration, however many readers.
    expect(fake.list("terminal.location", accountId)).toHaveLength(1);
  });

  it("registers a replacement under the same name on the same row, with a fresh key each attempt", async () => {
    const before = (
      await owner.query("select id, stripe_reader_id from devices where id = $1", [
        ids["dev_front_reader"],
      ])
    ).rows[0];
    const r = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/readers`,
      payload: { registration_code: "simulated-s710", label: "Front desk S710" },
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().id).toBe(ids["dev_front_reader"]);
    const after = (
      await owner.query("select stripe_reader_id from devices where id = $1", [
        ids["dev_front_reader"],
      ])
    ).rows[0];
    expect(after.stripe_reader_id).not.toBe(before.stripe_reader_id);
    expect(fake.requests.at(-1)?.idempotencyKey).toMatch(/^venue:.+:reader:/);
  });

  it("never takes an M2", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/readers`,
      payload: { registration_code: "simulated-m2", label: "Bar M2" },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details).toMatchObject({ reason: "unsupported_reader" });
    expect(
      fake
        .list("terminal.reader", accountId)
        .some((x) => String(x["device_type"]).endsWith("stripe_m2")),
    ).toBe(false);
  });

  it("shows both readers online in Admin and in the Console's rows after a health read, and offline after 2 minutes", async () => {
    await sweepReaders(owner, stripe, SEED_NOW);
    const r = await app.inject({ method: "GET", url: `/v1/venues/${venueId}/readers` });
    expect(
      r.json().readers.map((x: { label: string; online: boolean }) => [x.label, x.online]),
    ).toEqual([
      ["Bar S710", true],
      ["Front desk S710", true],
    ]);
    const devices = await withVenue(owner, { venueId }, (c) => listDevices(c, venueId));
    expect(devices.filter((d) => d.kind === "reader" && d.online)).toHaveLength(2);

    const bar = fake.list("terminal.reader", accountId).find((x) => x["label"] === "Bar S710")!;
    await fetch(`${fake.base}/fake/readers/${bar["id"]}/status`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "status=offline",
    });
    // The front desk keeps reporting; the bar reader doesn't.
    const at = (s: number) => SEED_NOW.add({ seconds: s });
    for (const s of [30, 60, 90]) await sweepReaders(owner, stripe, at(s));
    const early = await withVenue(owner, { venueId }, (c) =>
      flagQuietDevices(c, venueId, at(119), DEVICE_SILENCE_MS),
    );
    expect(early.offline).not.toContain(ids["dev_bar_reader"]);
    const late = await withVenue(owner, { venueId }, (c) =>
      flagQuietDevices(c, venueId, at(120), DEVICE_SILENCE_MS),
    );
    expect(late.offline).toContain(ids["dev_bar_reader"]);
    expect(late.offline).not.toContain(ids["dev_front_reader"]);
    const events = await owner.query(
      "select type from venue_events where entity_id = $1 and type = 'device.offline'",
      [ids["dev_bar_reader"]],
    );
    expect(events.rowCount).toBe(1);
  });

  it("answers not found for another venue's reader, and nothing reaches Stripe", async () => {
    const seen = fake.requests.length;
    const r = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/readers/${otherReader}/refresh`,
    });
    expect(r.statusCode).toBe(404);
    expect(fake.requests.length).toBe(seen);
    const ours = await app.inject({
      method: "POST",
      url: `/v1/venues/${venueId}/readers/${ids["dev_front_reader"]}/refresh`,
    });
    expect(ours.json()).toMatchObject({ label: "Front desk S710", online: true });
  });

  it("sends a new pay.tipScreen to the Terminal Configuration", async () => {
    const pay = (
      await app.inject({ method: "GET", url: `/v1/venues/${venueId}/settings/pay` })
    ).json().value;
    const r = await app.inject({
      method: "PUT",
      url: `/v1/venues/${venueId}/settings/pay`,
      payload: { value: { ...pay, tipScreen: { ...pay.tipScreen, pcts: [18, 20, 25] } } },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().readers).toBe("updating");
    const config = (
      await owner.query("select stripe_terminal_config_id as id from venues where id = $1", [
        venueId,
      ])
    ).rows[0].id;
    expect(fake.objects.get(config)).toMatchObject({
      tipping: { usd: { percentages: ["18", "20", "25"] } },
    });
  });
});
