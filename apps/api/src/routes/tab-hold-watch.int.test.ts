import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Worker, generateSigningKey, loadDemoSeed, publishRulePack } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, Temporal, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { makePaymentHandlers } from "../payments/run.js";
import { InjectedCrash, StripeClient } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { fakeStripeSettings } from "../stripe/settings.js";
import { seedStripe } from "../stripe/seed-stripe.js";
import { runHoldWatch } from "../tabs/expiry.js";
import { sweepTabCutOff } from "../tabs/walkout.js";

/**
 * The hold watch and settling failed captures (M6-17; Payment flows · Bar tab with a growing hold, steps 6
 * and 7; Data model · Tabs at the cut-off and at close; Money rules 16): Dev S.'s slip, never entered, is
 * captured at its $48.00 total with a $0 tip 12 hours before its hold's capture_before (as Stripe reports
 * it), and flagged; a hold 11 hours from running out alerts Andy, once; a capture_failed tab stays on the
 * manager's list until it's settled, and cash taken for it the next day posts to that day with
 * adjusts_business_date Fri Sep 25.
 */
interface World {
  db: TestDatabase;
  owner: pg.Pool;
  workerPool: pg.Pool;
  app: FastifyInstance;
  worker: Worker;
  fake: FakeStripe;
  venueId: string;
  ids: Record<string, string>;
  clock: FrozenClock;
  as: (slug: string, role: string) => void;
  crashAfterCapture: { on: boolean };
  stripe: StripeClient;
}

const at = (s: string) => Temporal.ZonedDateTime.from(s).toInstant();

async function world(): Promise<World> {
  const db = await createTestDatabase({ migrate: true });
  const venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } }))
    .venueId;
  const owner = new pg.Pool({ connectionString: db.url });
  const workerPool = appPool(db.url);
  const key = generateSigningKey().privateKeyPem;
  for (const pack of [newYorkCounty, newYorkCountyTaxed])
    await publishRulePack(owner, {
      pack,
      effectiveOn: "2026-09-01",
      approvedBy: ["A", "B"],
      privateKeyPem: key,
    });
  const ids = Object.fromEntries(
    (
      await owner.query<{ slug: string; id: string }>("select slug, row_id as id from seed_ids")
    ).rows.map((r) => [r.slug, r.id]),
  );
  const fake = new FakeStripe();
  const base = await fake.start();
  const crashAfterCapture = { on: false };
  const stripe = new StripeClient(fakeStripeSettings(base), fetch, 15_000, {
    // A run killed after Stripe captured, before the answer was written down (chaos).
    step: (name) => {
      if (name === "after-capture" && crashAfterCapture.on) {
        crashAfterCapture.on = false;
        throw new InjectedCrash(name);
      }
    },
  });
  await seedStripe(owner, stripe, () => undefined);
  const clock = new FrozenClock(SEED_NOW);
  let who: Principal | null = null;
  const as = (slug: string, role: string) => {
    who = {
      kind: "user",
      userId: ids[slug]!,
      session: role === "bartender" ? "pin" : "passkey",
      memberships: [{ venueId, membershipId: ids[`${slug}.membership`]!, role: role as never }],
    };
  };
  const app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    stripe,
    moduleCacheMs: 0,
    authenticators: [async () => who],
  });
  await app.ready();
  const worker = new Worker(workerPool, {
    pool: "critical",
    handlers: makePaymentHandlers({ pool: workerPool, stripe, clock }),
    clock,
  });
  return {
    db,
    owner,
    workerPool,
    app,
    worker,
    fake,
    venueId,
    ids,
    clock,
    as,
    crashAfterCapture,
    stripe,
  };
}

async function end(w: World) {
  await w.app.close();
  await w.fake.stop();
  await w.workerPool.end();
  await w.owner.end();
  await w.db.drop();
}

async function drain(w: World) {
  for (let i = 0; i < 6; i++) while ((await w.worker.tick()) > 0);
}

const ny = (s: string) => at(`${s}[America/New_York]`);
const q = <T extends pg.QueryResultRow>(w: World, sql: string, args: unknown[] = []) =>
  w.owner.query<T>(sql, args).then((r) => r.rows);

describe("The sweeper: Dev S.'s slip, never entered", () => {
  let w: World;
  // As Stripe reports it for an in-person Visa hold placed at 10:12 PM: two days on.
  const CAPTURE_BEFORE = "2026-09-27T22:12:00-04:00";
  beforeAll(async () => {
    w = await world();
    await w.owner.query(
      "update payments set capture_before = $2 where id = (select payment_id from tabs where id = $1)",
      [w.ids["slip_1"], CAPTURE_BEFORE],
    );
  });
  afterAll(async () => end(w));

  const devS = async () =>
    (
      await q<{
        state: string;
        status: string;
        pi: string;
        business_date: string;
        adjusts: string | null;
        closing: string;
        tip: number;
        capture: number;
        swept_at: string | null;
        entered_by: string | null;
      }>(
        w,
        `select t.state, p.status, p.stripe_pi_id as pi, p.business_date::text, p.adjusts_business_date::text as adjusts,
                x.state as closing, x.tip_cents as tip, x.capture_cents as capture,
                to_json(x.swept_at) #>> '{}' as swept_at, x.tip_entered_by as entered_by
           from tabs t join payments p on p.id = t.payment_id join tab_closings x on x.tab_id = t.id
          where t.id = $1`,
        [w.ids["slip_1"]],
      )
    )[0]!;

  it("is left alone until 12 hours before its hold runs out", async () => {
    w.clock.set(ny("2026-09-27T10:11:59-04:00"));
    expect((await runHoldWatch(w.workerPool, w.venueId, w.clock.now())).swept).toEqual([]);
    expect(await devS()).toMatchObject({ state: "awaiting_tip", closing: "slip", swept_at: null });
  });

  it("is captured at its $48.00 total with a $0 tip at 12 hours, flagged, and only once", async () => {
    w.clock.set(ny("2026-09-27T10:12:00-04:00"));
    expect((await runHoldWatch(w.workerPool, w.venueId, w.clock.now())).swept).toEqual([
      w.ids["slip_1"],
    ]);
    await drain(w);
    const after = await devS();
    expect(after).toMatchObject({
      state: "captured",
      status: "captured",
      closing: "captured",
      tip: 0,
      capture: 4800,
      entered_by: null,
      // Captured after its night, as a late slip is: today, pointing back at Fri Sep 25.
      business_date: "2026-09-27",
      adjusts: "2026-09-25",
    });
    expect(Temporal.Instant.from(after.swept_at!).toString()).toBe(
      ny("2026-09-27T10:12:00-04:00").toString(),
    );
    const pi = w.fake.objects.get(after.pi) as Record<string, unknown>;
    expect(Number(pi["amount_received"])).toBe(4800);
    // The next ticks find nothing to do: one capture with Stripe.
    w.clock.set(ny("2026-09-27T10:13:00-04:00"));
    await runHoldWatch(w.workerPool, w.venueId, w.clock.now());
    await drain(w);
    expect(Number(pi["_captures"] ?? 1)).toBe(1);
    w.as("andy", "manager");
    const seen = await w.app.inject({
      method: "GET",
      url: `/v1/venues/${w.venueId}/tabs/${w.ids["slip_1"]}/close`,
    });
    expect(seen.statusCode).toBe(200);
    expect(seen.json()).toMatchObject({ tip_cents: 0, capture_cents: 4800 });
    expect(seen.json().swept_at).not.toBeNull();
  });
});

describe("The hold-expiry alert", () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
    // Jess P.'s hold runs out 11 hours from now; Hana K.'s in 13.
    for (const [name, hours] of [
      ["Jess P.", 11],
      ["Hana K.", 13],
    ] as const)
      await w.owner.query(
        "update payments set capture_before = $2 where id = (select payment_id from tabs where name = $1)",
        [name, SEED_NOW.add({ hours }).toString()],
      );
  });
  afterAll(async () => end(w));

  const pushes = () =>
    q<{ dedupe_key: string; payload: { audience: unknown; message: unknown } }>(
      w,
      "select dedupe_key, payload from jobs where kind = 'push.send' and dedupe_key like 'tab-hold-expiring:%'",
    );

  it("tells the manager on duty about a hold 11 hours from running out, once", async () => {
    w.clock.set(SEED_NOW);
    const r = await runHoldWatch(w.workerPool, w.venueId, w.clock.now());
    const jess = await q<{ id: string }>(w, "select id from tabs where name = 'Jess P.'");
    expect(r.alerted).toEqual([jess[0]!.id]);
    const sent = await pushes();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toMatchObject({
      audience: { kind: "person", user_id: w.ids["andy"] },
      message: { key: "tabs.push.holdExpiring", params: { name: "Jess P." } },
    });
    const flagged = await q<{ name: string }>(
      w,
      "select name from tabs where hold_expiry_alerted_at is not null",
    );
    expect(flagged.map((x) => x.name)).toEqual(["Jess P."]);
    // A minute later: nothing new for Jess P.; Hana K.'s is still more than 12 hours out.
    w.clock.set(SEED_NOW.add({ minutes: 1 }));
    expect((await runHoldWatch(w.workerPool, w.venueId, w.clock.now())).alerted).toEqual([]);
    expect(await pushes()).toHaveLength(1);
    // Hana K.'s at 12 hours.
    w.clock.set(SEED_NOW.add({ hours: 1 }));
    expect((await runHoldWatch(w.workerPool, w.venueId, w.clock.now())).alerted).toHaveLength(1);
    expect(await pushes()).toHaveLength(2);
  });
});

describe("Settling a capture_failed tab (screens Night note 12)", () => {
  let w: World;
  const SAT = "2026-09-26";
  beforeAll(async () => {
    w = await world();
    // Seat 6's hold is $10.00 with no overcapture, and its saved card declines: the cut-off leaves it
    // capture_failed, owing $3.07.
    await w.owner.query("update tabs set hold_cents = 1000 where name = 'Seat 6 · blue jacket'");
    await w.owner.query(
      `update payments p set overcapture_supported = false, generated_card_pm = 'pm_card_chargeCustomerFail'
         from tabs t where t.payment_id = p.id and t.name = 'Seat 6 · blue jacket'`,
    );
    w.clock.set(ny("2026-09-26T04:30:00-04:00"));
    await sweepTabCutOff(w.workerPool, w.clock.now());
    await drain(w);
  });
  afterAll(async () => end(w));

  const seat6 = async () =>
    (
      await q<{ id: string; state: string; closed_by: string | null }>(
        w,
        "select id, state, closed_by from tabs where name = 'Seat 6 · blue jacket'",
      )
    )[0]!;
  const settle = (body: unknown, key = `settle-${Math.random()}`) =>
    seat6().then((t) =>
      w.app.inject({
        method: "POST",
        url: `/v1/venues/${w.venueId}/tabs/${t.id}/settle`,
        headers: { "idempotency-key": key },
        payload: body as never,
      }),
    );
  const night = (date: string) =>
    w.app.inject({ method: "GET", url: `/v1/venues/${w.venueId}/nights/${date}` });

  it("stays on the manager's list, with what it owes, the next night too", async () => {
    expect((await seat6()).state).toBe("capture_failed");
    w.clock.set(ny("2026-09-26T21:00:00-04:00"));
    w.as("andy", "manager");
    const r = await night(SAT);
    expect(r.statusCode).toBe(200);
    expect(r.json().capture_failed).toEqual([
      {
        id: (await seat6()).id,
        name: "Seat 6 · blue jacket",
        check_id: expect.any(String),
        card: { brand: "Amex", last4: "7712" },
        business_date: "2026-09-25",
        owed_cents: 307,
        saved_card: true,
      },
    ]);
  });

  it("is a manager's: Maya at the bar can't settle it", async () => {
    w.as("maya", "bartender");
    const r = await settle({ method: "cash", amount_cents: 307, tendered_cents: 500 });
    expect(r.statusCode).toBe(403);
    expect((await seat6()).state).toBe("capture_failed");
  });

  it("asks the amount it owes: a stale amount charges nothing", async () => {
    w.as("andy", "manager");
    const r = await settle({ method: "cash", amount_cents: 300, tendered_cents: 500 });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details).toMatchObject({ reason: "amount_changed", amount_cents: 307 });
  });

  it("stays capture_failed when the saved card declines again", async () => {
    w.as("andy", "manager");
    const r = await settle({ method: "saved_card", amount_cents: 307 });
    expect(r.statusCode).toBe(201);
    await drain(w);
    expect((await seat6()).state).toBe("capture_failed");
    const left = await night(SAT);
    expect(left.json().capture_failed[0]).toMatchObject({ owed_cents: 307 });
  });

  it("settled in cash the next day: closed, posted to Sat Sep 26 with adjusts_business_date Fri Sep 25", async () => {
    w.as("andy", "manager");
    const r = await settle({ method: "cash", amount_cents: 307, tendered_cents: 500 });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ change_cents: 193, tab_state: "closed" });
    const tab = await seat6();
    expect(tab).toMatchObject({ state: "closed", closed_by: w.ids["andy"] });
    const pay = await q<{ business_date: string; adjusts: string | null; amount: number }>(
      w,
      `select business_date::text, adjusts_business_date::text as adjusts, amount_cents::int as amount
         from payments where id = $1`,
      [r.json().id],
    );
    expect(pay[0]).toEqual({ business_date: SAT, adjusts: "2026-09-25", amount: 307 });
    expect((await night(SAT)).json().capture_failed).toEqual([]);
    // Settled once: a second settle finds a closed tab.
    const again = await settle({ method: "cash", amount_cents: 307, tendered_cents: 500 });
    expect(again.statusCode).toBe(400);
  });
});
