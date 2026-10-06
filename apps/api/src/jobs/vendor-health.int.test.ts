import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { StripeClient, StripeUnknownResult } from "../stripe/client.js";
import { fakeStripeSettings } from "../stripe/settings.js";
import { TwilioVenueClient } from "../texts/venue.js";
import { databaseVendorObserver, setVendorObserver } from "../vendors/outcomes.js";
import { loadVendorHealthSettings, sweepVendorHealth } from "./vendor-health.js";

/** M8-01 on the demo seed at 10:41 PM: the connection route, the vendor-health job and our error rates. */
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
const clock = new SimulatedClock(SEED_NOW);
const settings = loadVendorHealthSettings({});
type Connection = {
  backup_internet: boolean;
  vendors: { stripe: "ok" | "trouble"; twilio: "ok" | "trouble" };
};
const connection = async () =>
  (await app.inject({ method: "GET", url: `/v1/venues/${venueId}/connection` })).json<Connection>();
const healthEvents = async () =>
  Number(
    (
      await raw.query<{ n: string }>(
        "select count(*) as n from venue_events where venue_id = $1 and type = 'vendor.health'",
        [venueId],
      )
    ).rows[0]!.n,
  );
const force = (vendor: "stripe" | "twilio", calls: number, errors: number) =>
  raw.query(
    `insert into vendor_calls (venue_id, vendor, minute, calls, errors)
     values ($1, $2, date_trunc('minute', $3::timestamptz), $4, $5)
     on conflict (venue_id, vendor, minute) do update set calls = excluded.calls, errors = excluded.errors`,
    [venueId, vendor, SEED_NOW.toString(), calls, errors],
  );

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  pool = appPool(db.url);
  const m = (
    await raw.query<{ id: string; user_id: string }>(
      "select id, user_id from memberships where venue_id = $1 and role = 'bartender'",
      [venueId],
    )
  ).rows[0]!;
  const maya: Principal = {
    kind: "user",
    userId: m.user_id,
    session: "pin",
    memberships: [{ venueId, membershipId: m.id, role: "bartender" }],
  };
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [async () => maya],
    moduleCacheMs: 0,
  });
  await app.ready();
});

afterAll(async () => {
  setVendorObserver(null);
  await app.close();
  await pool.end();
  await raw.end();
  await db.drop();
});

describe("the venue's connection (M8-01)", () => {
  it("is online with both vendors ok on the seed", async () => {
    expect(await connection()).toMatchObject({
      backup_internet: false,
      vendors: { stripe: "ok", twilio: "ok" },
    });
  });

  it("is on backup internet while the router reports LTE", async () => {
    const router = `update device_heartbeats h set network = jsonb_set(h.network, '{on_backup_now}', $2::jsonb)
                      from devices d where d.id = h.device_id and d.venue_id = $1 and d.kind = 'router'`;
    await raw.query(router, [venueId, "true"]);
    expect((await connection()).backup_internet).toBe(true);
    await raw.query(router, [venueId, "false"]);
    expect((await connection()).backup_internet).toBe(false);
  });

  it("puts Stripe in trouble when our error rate passes its threshold, and clears it", async () => {
    const before = await healthEvents();
    await force("stripe", 10, 4);
    await sweepVendorHealth(pool, SEED_NOW, settings);
    expect((await connection()).vendors).toEqual({ stripe: "trouble", twilio: "ok" });
    const row = await raw.query(
      "select source from vendor_health where venue_id = $1 and vendor = 'stripe'",
      [venueId],
    );
    expect(row.rows[0]).toEqual({ source: "venue_errors" });
    expect(await healthEvents()).toBe(before + 1);
    // A second sweep with the same verdict raises nothing.
    await sweepVendorHealth(pool, SEED_NOW, settings);
    expect(await healthEvents()).toBe(before + 1);
    // Five minutes on, those calls are out of the window: cleared.
    await sweepVendorHealth(pool, SEED_NOW.add({ minutes: 6 }), settings);
    expect((await connection()).vendors.stripe).toBe("ok");
    expect(await healthEvents()).toBe(before + 2);
  });

  it("puts texts in trouble when Twilio's status feed reports a major incident", async () => {
    await raw.query("delete from vendor_calls where venue_id = $1", [venueId]);
    const feeds = {
      ...settings,
      statusUrls: { stripe: null, twilio: "https://status.test/api/v2/status.json" },
    };
    const major = (async () =>
      new Response(JSON.stringify({ status: { indicator: "major" } }))) as unknown as typeof fetch;
    await sweepVendorHealth(pool, SEED_NOW, feeds, major);
    expect((await connection()).vendors).toEqual({ stripe: "ok", twilio: "trouble" });
    const fine = (async () =>
      new Response(JSON.stringify({ status: { indicator: "none" } }))) as unknown as typeof fetch;
    await sweepVendorHealth(pool, SEED_NOW, feeds, fine);
    expect((await connection()).vendors.twilio).toBe("ok");
  });

  it("counts our own calls to Stripe and Twilio against the venue behind the account", async () => {
    await raw.query("delete from vendor_calls where venue_id = $1", [venueId]);
    await raw.query(
      "update organizations set stripe_account_id = 'acct_m801' where id = (select org_id from venues where id = $1)",
      [venueId],
    );
    await raw.query(
      `insert into integrations (venue_id, kind, external_id, status)
       values ($1, 'twilio', 'AC_m801', 'connected')`,
      [venueId],
    );
    setVendorObserver(databaseVendorObserver(pool, clock));
    // Stripe answers 503 twice (no answer: trouble) and 402 once (a decline: an answer).
    let status = 503;
    const stripe = new StripeClient(
      fakeStripeSettings("http://stripe.test"),
      (async () =>
        new Response(JSON.stringify({ error: { type: "card_error" } }), {
          status,
        })) as unknown as typeof fetch,
    );
    const read = () => stripe.call("payments", "GET", "/v1/balance", { account: "acct_m801" });
    await expect(read()).rejects.toBeInstanceOf(StripeUnknownResult);
    await expect(read()).rejects.toBeInstanceOf(StripeUnknownResult);
    status = 402;
    await expect(read()).rejects.toThrow();
    // Twilio doesn't answer once.
    const twilio = new TwilioVenueClient("http://twilio.test", (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch);
    await expect(
      twilio.send(
        { accountSid: "AC_m801", authToken: "x" },
        {
          to: "+13475550177",
          from: "+12125550100",
          body: "Your room is ready",
          statusCallback: null,
        },
      ),
    ).rejects.toThrow();
    // The observer writes after the call; wait for it.
    let rows: { vendor: string; calls: number; errors: number }[] = [];
    for (let i = 0; i < 50; i++) {
      rows = (
        await raw.query<{ vendor: string; calls: number; errors: number }>(
          "select vendor, calls, errors from vendor_calls where venue_id = $1 order by vendor",
          [venueId],
        )
      ).rows;
      if (rows.reduce((n, r) => n + r.calls, 0) >= 4) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(rows).toEqual([
      { vendor: "stripe", calls: 3, errors: 2 },
      { vendor: "twilio", calls: 1, errors: 1 },
    ]);
  });
});
