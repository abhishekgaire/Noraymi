import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import {
  asRetention,
  encryptSecret,
  eraseGuest,
  generateSigningKey,
  type JobRow,
  loadDemoSeed,
  publishRulePack,
  restorePreflight,
  saveTwilioIntegration,
  startErasure,
  venueRowHashes,
  withVenue,
} from "@west4/db";
import {
  appPool,
  copyTestDatabase,
  createTestDatabase,
  type TestDatabase,
} from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { StripeClient } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { seedStripe } from "../stripe/seed-stripe.js";
import { fakeStripeSettings } from "../stripe/settings.js";
import { FakeVenueClient } from "../texts/venue.js";
import {
  RestoreRefused,
  makeRestorePullHandler,
  restoreVenue,
  type RestoreReport,
} from "./restore.js";

/**
 * The restore drill, rehearsed locally (M8-20): West 4 (the demo seed, with
 * its Stripe side on the fake) and a second venue of the same organization.
 *
 *   1. The scratch copy is taken (the restore point).
 *   2. After it, West 4 takes a card payment and erases Tanya W., and a guest
 *      texts in; the other venue carries on.
 *   3. Disaster: every West 4 row is lost (the erasure log survives).
 *   4. West 4 is restored from the copy while the other venue keeps working.
 *
 * The other venue's rows are unchanged by hash, the payments match Stripe's
 * PaymentIntents for the window in count and amount, the time is on the
 * venue's restores row against the 2-hour target, Tanya stays erased, and
 * the API answers West 4's board from the restored rows.
 */
let db: TestDatabase;
let scratch: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let scratchPool: pg.Pool;
let fake: FakeStripe;
let stripe: StripeClient;
let api: FastifyInstance;
let venueId = "";
let otherVenue = "";
let tanya = "";
let restorePoint = "";
let report: RestoreReport;
let before: Record<string, string> = {};
let during: Record<string, string> = {};
let otherWroteMidway = "";
let lateIntent = "";
const clock = new SimulatedClock(SEED_NOW);
const texts = new FakeVenueClient();
const secretKey = Buffer.alloc(32, 7);

const one = async <T>(p: pg.Pool, sql: string, params: unknown[] = []) =>
  (await p.query(sql, params)).rows[0] as T;

function openPools(): void {
  owner = new pg.Pool({ connectionString: db.url, max: 4 });
  app = appPool(db.url);
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  openPools();
  const key = generateSigningKey().privateKeyPem;
  for (const pack of [newYorkCounty, newYorkCountyTaxed])
    await publishRulePack(owner, {
      pack,
      effectiveOn: "2026-09-01",
      approvedBy: ["A", "B"],
      privateKeyPem: key,
    });
  fake = new FakeStripe();
  stripe = new StripeClient(fakeStripeSettings(await fake.start()));
  await seedStripe(owner, stripe, () => undefined);
  await withVenue(app, { venueId }, (c) =>
    saveTwilioIntegration(c, venueId, {
      accountSid: "ACrestore",
      phoneE164: "+12125550100",
      secretEnc: encryptSecret(secretKey, "token"),
      at: SEED_NOW.toString(),
    }),
  );
  otherVenue = (
    await one<{ id: string }>(
      owner,
      `insert into venues (org_id, name, slug) select org_id, 'Other Room', 'other-restore' from venues where id = $1
       returning id`,
      [venueId],
    )
  ).id;
  for (const [name, phone] of [
    ["Bea O.", "+12125550301"],
    ["Cal O.", "+12125550302"],
  ])
    await owner.query("insert into guests (venue_id, name, phone_e164) values ($1, $2, $3)", [
      otherVenue,
      name,
      phone,
    ]);
  tanya = (
    await one<{ id: string }>(owner, "select row_id as id from seed_ids where slug = 'g_tanya'")
  ).id;

  // 1. The scratch copy: the cluster at the restore point.
  await new Promise((r) => setTimeout(r, 1100));
  restorePoint = new Date().toISOString();
  await owner.end();
  await app.end();
  scratch = await copyTestDatabase(db);
  openPools();
  scratchPool = new pg.Pool({ connectionString: scratch.url, max: 2 });

  // 2. After the restore point: a card payment, an erasure and a reply.
  const account = (
    await one<{ a: string }>(
      owner,
      "select o.stripe_account_id as a from organizations o join venues v on v.org_id = o.id where v.id = $1",
      [venueId],
    )
  ).a;
  const pi = await stripe.call<{ id: string; status: string }>(
    "payments",
    "POST",
    "/v1/payment_intents",
    {
      account,
      idempotencyKey: "restore-test:late",
      params: {
        amount: 4500,
        currency: "usd",
        payment_method: "pm_card_visa",
        payment_method_types: ["card"],
        confirm: true,
      },
    },
  );
  expect(pi.status).toBe("succeeded");
  lateIntent = pi.id;
  await owner.query(
    `insert into payments (venue_id, method, status, stripe_pi_id, amount_cents, business_date)
     values ($1, 'card_online', 'captured', $2, 4500, '2026-09-25')`,
    [venueId, pi.id],
  );
  await withVenue(app, { venueId, requestId: "test:erase" }, async (c) => {
    const id = await startErasure(c, venueId, {
      subject: "guest",
      subjectId: tanya,
      requestedBy: null,
      now: clock.now(),
    });
    await asRetention(c);
    await eraseGuest(c, venueId, tanya, id, clock.now());
  });
  texts.listed.push({
    account: "ACrestore",
    message: {
      sid: "SMrestorereply",
      direction: "inbound",
      status: "received",
      from: "+12125550999",
      to: "+12125550100",
      body: "running 10 min late",
      createdAt: new Date().toISOString(),
      errorCode: null,
    },
  });

  // 3. Disaster: every West 4 row is lost, but the erasure log and the audit log survive.
  const client = await owner.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    const tables = await client.query<{ name: string }>(
      `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'venue_id')
          and c.relname not in ('erasures', 'audit_log', 'venue_events', 'jobs', 'restores')`,
    );
    for (const t of tables.rows)
      await client.query(`delete from "${t.name}" where venue_id = $1`, [venueId]);
    await client.query("commit");
  } finally {
    client.release();
  }
  expect(
    (
      await one<{ n: string }>(owner, "select count(*) as n from payments where venue_id = $1", [
        venueId,
      ])
    ).n,
  ).toBe("0");

  // 4. The restore, while the other venue keeps working.
  before = await venueRowHashes(owner, otherVenue);
  report = await restoreVenue(
    {
      target: owner,
      app,
      scratch: scratchPool,
      clock,
      stripe,
      venueTexts: { client: texts, secretKey },
    },
    {
      venueId,
      kind: "drill",
      restorePoint,
      scratchName: "west4_scratch",
      scratchReadyS: 0,
      pull: "now",
      afterTable: async (_table, index, of) => {
        if (index !== Math.floor(of / 2)) return;
        // Midway: the other venue takes a new guest, and its rows are read.
        otherWroteMidway = (
          await withVenue(app, { venueId: otherVenue, requestId: "test:other" }, (c) =>
            c.query<{ id: string }>(
              "insert into guests (venue_id, name, phone_e164) values ($1, 'Dee O.', '+12125550303') returning id",
              [otherVenue],
            ),
          )
        ).rows[0]!.id;
        during = await venueRowHashes(owner, otherVenue);
      },
    },
  );

  // The API on the restored data, as West 4's owner.
  const ids = Object.fromEntries(
    (
      await owner.query<{ slug: string; id: string }>(
        "select slug, row_id as id from seed_ids where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.slug, r.id]),
  );
  const abhishek = {
    kind: "user",
    userId: ids["abhishek"]!,
    session: "passkey",
    memberships: [{ venueId, membershipId: ids["abhishek.membership"]!, role: "owner" }],
  } as Principal;
  api = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    authenticators: [async () => abhishek],
    moduleCacheMs: 0,
  });
  await api.ready();
}, 120_000);

afterAll(async () => {
  await api?.close();
  await fake?.stop();
  await scratchPool?.end();
  await owner?.end();
  await app?.end();
  await scratch?.drop();
  await db?.drop();
});

describe("restore one venue from a scratch copy (M8-20)", () => {
  it("puts every row back without a refusal, audited under the restore", async () => {
    expect(report.counts.skipped).toEqual({});
    const counts = async (p: pg.Pool, table: string) =>
      Number(
        (
          await one<{ n: string }>(p, `select count(*) as n from ${table} where venue_id = $1`, [
            venueId,
          ])
        ).n,
      );
    expect(report.counts.settingsVersions).toBe(0);
    for (const t of [
      "venue_settings",
      "rooms",
      "checks",
      "check_lines",
      "orders",
      "guests",
      "bookings",
      "tip_ledger",
    ])
      expect(await counts(owner, t), t).toBe(await counts(scratchPool, t));
    expect(report.counts.inserted["payments"]).toBe(await counts(scratchPool, "payments"));
    const audited = await owner.query<{ venue_id: string; n: string }>(
      "select venue_id, count(*) as n from audit_log where request_id = $1 group by venue_id",
      [`restore:${report.restoreId}`],
    );
    expect(audited.rows.map((r) => r.venue_id)).toEqual([venueId]);
    expect(Number(audited.rows[0]!.n)).toBeGreaterThan(100);
  });

  it("leaves the other venue's rows unchanged, compared by hash, while it keeps working", async () => {
    const after = await venueRowHashes(owner, otherVenue);
    expect(after).toEqual(during);
    // Between before and midway, only the other venue's own new guest (and its audit row) changed.
    const changed = Object.keys(before).filter((t) => before[t] !== during[t]);
    expect(changed.sort()).toEqual(["audit_log", "guests"]);
    expect(otherWroteMidway).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("matches Stripe's PaymentIntents for the window in count and amount", () => {
    expect(report.pulled?.unmatched_payments).toBe(1);
    expect(report.stripeCheck).toMatchObject({
      match: true,
      stripe: { count: 1, cents: 4500 },
      ours: { count: 1, cents: 4500 },
    });
  });

  it("brings back the payment taken after the restore point as an unmatched payment", async () => {
    const p = await one<{ method: string; amount_cents: string }>(
      owner,
      "select method, amount_cents from payments where stripe_pi_id = $1",
      [lateIntent],
    );
    expect(p).toEqual({ method: "external", amount_cents: "4500" });
  });

  it("records the drill's time against the recovery target", async () => {
    const r = await one<Record<string, unknown>>(
      owner,
      "select kind, state, rto_target_s, within_target, applied_at is not null as applied, finished_at is not null as finished from restores where id = $1",
      [report.restoreId],
    );
    expect(r).toEqual({
      kind: "drill",
      state: "done",
      rto_target_s: 7200,
      within_target: true,
      applied: true,
      finished: true,
    });
    expect(report.timings.totalS).toBeGreaterThan(0);
    expect(report.target).toEqual({ rtoS: 7200, withinTarget: true });
  });

  it("keeps a guest erased after the restore point erased", async () => {
    const g = await one<Record<string, unknown>>(
      owner,
      "select name, phone_e164, email, erased_at is not null as erased from guests where id = $1",
      [tanya],
    );
    expect(g).toEqual({ name: "", phone_e164: null, email: null, erased: true });
    const copy = await one<{ name: string }>(scratchPool, "select name from guests where id = $1", [
      tanya,
    ]);
    expect(copy.name).toBe("Tanya W.");
    expect(report.erasures?.reapplied).toBe(1);
  });

  it("pulls Twilio's messages since the restore point into the inbox, once", async () => {
    expect(report.pulled?.twilio_replies).toBe(1);
    const m = await one<{ n: string }>(
      owner,
      "select count(*) as n from messages where venue_id = $1 and provider_sid = 'SMrestorereply'",
      [venueId],
    );
    expect(m.n).toBe("1");
  });

  it("boots the API on the restored rows", async () => {
    const r = await api.inject({ method: "GET", url: `/v1/venues/${venueId}/board` });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("Room 9");
  });

  it("puts nothing back twice, brings a changed setting back as a new version, and queues the pull", async () => {
    // A bad change after the restore point: the website's settings blanked.
    await owner.query(
      `insert into venue_settings (venue_id, key, version, value, starts_on)
       select venue_id, key, version + 1, '{}'::jsonb, starts_on from venue_settings
        where venue_id = $1 and key = 'website' order by version desc limit 1`,
      [venueId],
    );
    const again = await restoreVenue(
      { target: owner, app, scratch: scratchPool, clock, stripe },
      { venueId, kind: "restore", restorePoint, scratchName: "west4_scratch", pull: "job" },
    );
    expect(again.counts.inserted).toEqual({});
    expect(again.counts.settingsVersions).toBe(1);
    const website = `select value from venue_settings where venue_id = $1 and key = 'website' order by version desc limit 1`;
    expect((await one<{ value: unknown }>(owner, website, [venueId])).value).toEqual(
      (await one<{ value: unknown }>(scratchPool, website, [venueId])).value,
    );
    expect(again.pulled).toBeNull();
    const job = await one<{ kind: string }>(
      owner,
      "select kind from jobs where venue_id = $1 and payload ->> 'restore_id' = $2",
      [venueId, again.restoreId],
    );
    expect(job.kind).toBe("restore.pull");
    const state = () =>
      one<{ state: string }>(owner, "select state from restores where id = $1", [again.restoreId]);
    expect((await state()).state).toBe("pulling");
    await makeRestorePullHandler({ app, clock, stripe })({
      job: { venue_id: venueId, payload: { restore_id: again.restoreId } } as unknown as JobRow,
      clock,
      step: (work) => withVenue(app, { venueId }, work),
    });
    expect((await state()).state).toBe("done");
  });

  it("refuses a scratch copy that is production itself, and a trigger that wouldn't step aside", async () => {
    await expect(
      restoreVenue(
        { target: owner, app, scratch: owner, clock },
        { venueId, kind: "restore", restorePoint, scratchName: "self", pull: "now" },
      ),
    ).rejects.toBeInstanceOf(RestoreRefused);
    await owner.query(
      `create function zz_restore_probe() returns trigger language plpgsql as $$ begin return new; end $$;
       create trigger zz_restore_probe before insert on lost_items for each row execute function zz_restore_probe();`,
    );
    try {
      expect(await restorePreflight(owner, scratchPool, venueId)).toContain(
        "the trigger lost_items.zz_restore_probe doesn't step aside for a restore (restoring())",
      );
    } finally {
      await owner.query(
        "drop trigger zz_restore_probe on lost_items; drop function zz_restore_probe();",
      );
    }
  });

  it("walls the restore role to the venue in app.venue_id", async () => {
    const c = await owner.connect();
    try {
      await c.query("begin");
      await c.query("set local role app_migrator");
      await c.query("select set_config('app.venue_id', $1, true)", [venueId]);
      const seen = await c.query<{ venue_id: string }>("select distinct venue_id from guests");
      expect(seen.rows.map((r) => r.venue_id)).toEqual([venueId]);
      await expect(
        c.query("insert into guests (venue_id, name) values ($1, 'Wall')", [otherVenue]),
      ).rejects.toThrow(/row-level security/);
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});
