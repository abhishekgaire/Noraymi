import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Worker, generateSigningKey, loadDemoSeed, publishRulePack, withVenue } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, Temporal, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { makePaymentHandlers } from "../payments/run.js";
import { reconcileVenue } from "../payments/reconcile.js";
import { InjectedCrash, StripeClient } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { fakeStripeSettings } from "../stripe/settings.js";
import { seedStripe } from "../stripe/seed-stripe.js";
import { startWalkout, sweepTabCutOff } from "../tabs/walkout.js";

/**
 * Walkouts and the tab cut-off (M6-16; Payment flows · Bar tab with a growing hold, step 6; Data model ·
 * Tabs at the cut-off and at close): Charge the remaining tabs shows 4 cards and $152.43 (Hana K., Jess P.,
 * Luis M. and Seat 6), skips Tariq A.'s tab while Diego's void waits, and captures each at its balance with
 * no tip; at 4:30 AM the cut-off charges Jess P.'s $32.66 as a walkout, once, also on both daylight-saving
 * nights; a tipping tab waits until it's open again; a run killed midway captures nothing twice; a tab over
 * its hold plus the allowance puts the rest on the saved card, or, when that declines, is capture_failed
 * and Andy hears.
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
const SAT_430 = "2026-09-26T04:30:00-04:00[America/New_York]";

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

interface TabState {
  name: string;
  state: string;
  captured: number | null;
  pi_status: string | null;
  stripe_captures: number | null;
  capture_attempts: number;
}
/** Each seed bar tab: its state, what its hold captured on Stripe, and how many capture calls were written. */
async function tabs(w: World): Promise<Record<string, TabState>> {
  const r = await w.owner.query<{
    name: string;
    state: string;
    pi: string | null;
    attempts: number;
  }>(
    `select t.name, t.state, p.stripe_pi_id as pi,
            (select count(*)::int from payment_attempts a where a.payment_id = p.id and a.action = 'capture') as attempts
       from tabs t join payments p on p.id = t.payment_id
      where t.name in ('Hana K.', 'Jess P.', 'Luis M.', 'Tariq A.', 'Seat 6 · blue jacket')`,
  );
  return Object.fromEntries(
    r.rows.map((x) => {
      const pi = x.pi ? (w.fake.objects.get(x.pi) as Record<string, unknown>) : null;
      return [
        x.name,
        {
          name: x.name,
          state: x.state,
          captured: pi ? Number(pi["amount_received"]) : null,
          pi_status: pi ? String(pi["status"]) : null,
          stripe_captures: pi ? Number(pi["_captures"] ?? 0) : null,
          capture_attempts: x.attempts,
        },
      ];
    }),
  );
}

describe("Charge the remaining tabs (screens Night note 5)", () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  });
  afterAll(async () => end(w));

  const night = () =>
    w.app.inject({ method: "GET", url: `/v1/venues/${w.venueId}/nights/2026-09-25` });
  const charge = (body: unknown, key = `charge-${Math.random()}`) =>
    w.app.inject({
      method: "POST",
      url: `/v1/venues/${w.venueId}/nights/2026-09-25/charge-remaining-tabs`,
      headers: { "idempotency-key": key },
      payload: body as never,
    });

  it("shows 4 cards and $152.43, and Tariq A.'s tab waiting for Andy is left out", async () => {
    w.as("andy", "manager");
    const r = await night();
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json<{
      charge_remaining: { count: number; total_cents: number };
      bar_tabs: {
        name: string;
        card: { last4: string } | null;
        total_cents: number;
        chargeable: boolean;
        waiting_for: string | null;
      }[];
      tab_cut_off_at: string;
    }>();
    expect(body.charge_remaining).toEqual({ count: 4, total_cents: 15243 });
    expect(body.bar_tabs.map((t) => [t.name, t.card?.last4, t.total_cents, t.chargeable])).toEqual([
      ["Hana K.", "5120", 4355, true],
      ["Jess P.", "4417", 3266, true],
      ["Luis M.", "2281", 6315, true],
      ["Tariq A.", "8830", 8601, false],
      ["Seat 6 · blue jacket", "7712", 1307, true],
    ]);
    expect(body.bar_tabs.find((t) => t.name === "Tariq A.")!.waiting_for).toMatch(/^Andy/);
    expect(body.tab_cut_off_at).toBe("2026-09-26T08:30:00Z");
  });

  it("is a manager's: Maya at the bar can't charge them", async () => {
    w.as("maya", "bartender");
    expect((await charge({ count: 4, total_cents: 15243 })).statusCode).toBe(403);
  });

  it("charges nothing when what was confirmed no longer matches", async () => {
    w.as("andy", "manager");
    const r = await charge({ count: 4, total_cents: 15000 });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({
      error: { details: { reason: "tabs_changed", count: 4, total_cents: 15243 } },
    });
    expect(Object.values(await tabs(w)).every((t) => t.state === "open")).toBe(true);
  });

  it("captures each of the four at its balance with no tip, as walkouts, and leaves Tariq A.'s open", async () => {
    w.as("andy", "manager");
    const r = await charge({ count: 4, total_cents: 15243 });
    expect(r.statusCode, r.body).toBe(200);
    await drain(w);
    const after = await tabs(w);
    expect(
      Object.values(after).map((t) => [t.name, t.state, t.captured, t.capture_attempts]),
    ).toEqual(
      expect.arrayContaining([
        ["Hana K.", "walkout_captured", 4355, 1],
        ["Jess P.", "walkout_captured", 3266, 1],
        ["Luis M.", "walkout_captured", 6315, 1],
        ["Seat 6 · blue jacket", "walkout_captured", 1307, 1],
        ["Tariq A.", "open", 0, 0],
      ]),
    );
    // No tip, Andy's name on it, and the drinks with their times kept as dispute evidence.
    const closings = await w.owner.query<{
      name: string;
      walkout: string;
      tip_cents: number;
      closed_by: string;
      evidence: { lines: { description: string; added_at: string }[] };
    }>(
      `select t.name, x.walkout, x.tip_cents, x.closed_by, x.evidence
         from tab_closings x join tabs t on t.id = x.tab_id where x.walkout is not null order by t.opened_at`,
    );
    expect(closings.rows).toHaveLength(4);
    for (const x of closings.rows) {
      expect(x).toMatchObject({
        walkout: "charge_remaining",
        tip_cents: 0,
        closed_by: w.ids["andy"],
      });
      expect(x.evidence.lines.length).toBeGreaterThan(0);
      expect(x.evidence.lines.every((l) => Temporal.Instant.from(l.added_at))).toBeTruthy();
    }
    const jess = closings.rows.find((x) => x.name === "Jess P.")!;
    expect(jess.evidence.lines.map((l) => l.description)).toEqual(
      expect.arrayContaining(["Modelo", "Jäger Bomb"]),
    );
    // Nothing more to charge: the night now shows only Tariq A.'s tab.
    const left = (await night()).json<{
      charge_remaining: { count: number; total_cents: number };
      bar_tabs: { name: string }[];
    }>();
    expect(left.charge_remaining).toEqual({ count: 0, total_cents: 0 });
    expect(left.bar_tabs.map((t) => t.name)).toEqual(["Tariq A."]);
  });
});

describe("The 4:30 AM tab cut-off", () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  });
  afterAll(async () => end(w));

  const runs = async (date: string) =>
    (
      await w.owner.query<{ due_at: string; started_at: string; finished: boolean }>(
        `select to_json(due_at) #>> '{}' as due_at, to_json(started_at) #>> '{}' as started_at,
                finished_at is not null as finished
           from tab_cut_off_runs where business_date = $1`,
        [date],
      )
    ).rows.map((r) => ({
      ...r,
      due_at: Temporal.Instant.from(r.due_at).toString(),
      started_at: Temporal.Instant.from(r.started_at).toString(),
    }));

  it("waits for a tipping tab, never starts a tab twice after a run killed midway, and charges Jess P. $32.66 at 4:30 AM", async () => {
    // Not a second early.
    w.clock.set(at("2026-09-26T04:29:59-04:00[America/New_York]"));
    expect(await sweepTabCutOff(w.workerPool, w.clock.now())).toBe(0);
    expect(await runs("2026-09-25")).toEqual([]);

    // A run killed midway: Hana K.'s walkout was written, nothing else.
    w.clock.set(at(SAT_430));
    const hana = (await w.owner.query<{ id: string }>("select id from tabs where name = 'Hana K.'"))
      .rows[0]!.id;
    await withVenue(w.workerPool, { venueId: w.venueId, requestId: "test" }, (c) =>
      startWalkout(c, w.venueId, hana, { by: "cut_off", userId: null, now: w.clock.now() }),
    );
    // Seat 6's guest is on the tip screen right now.
    await w.owner.query("update tabs set state = 'tipping' where name = 'Seat 6 · blue jacket'");
    // And the run capturing Hana K.'s hold, the first to go, dies after Stripe took the money.
    w.crashAfterCapture.on = true;

    expect(await sweepTabCutOff(w.workerPool, w.clock.now())).toBe(3); // Jess P., Luis M., Tariq A.
    expect(await runs("2026-09-25")).toEqual([
      { due_at: "2026-09-26T08:30:00Z", started_at: "2026-09-26T08:30:00Z", finished: false },
    ]);
    await drain(w);
    let now = await tabs(w);
    expect(now["Jess P."]).toMatchObject({ state: "walkout_captured", captured: 3266 });
    expect(now["Luis M."]).toMatchObject({ state: "walkout_captured", captured: 6315 });
    expect(now["Seat 6 · blue jacket"]!.state).toBe("tipping");
    // Hana K.'s capture went through on Stripe but the run died: "Checking with Stripe", settled by the
    // reconciler, never sent again.
    expect(now["Hana K."]).toMatchObject({ state: "open", stripe_captures: 1 });
    w.clock.set(at("2026-09-26T04:33:00-04:00[America/New_York]"));
    await drain(w);
    await reconcileVenue({ pool: w.workerPool, stripe: w.stripe, clock: w.clock }, w.venueId);
    await drain(w);
    expect((await tabs(w))["Hana K."]).toMatchObject({ state: "walkout_captured", captured: 4355 });

    // The guest cancelled on the reader: the tab is open again, and the next tick charges it.
    await w.owner.query("update tabs set state = 'open' where name = 'Seat 6 · blue jacket'");
    w.clock.set(at("2026-09-26T04:33:15-04:00[America/New_York]"));
    expect(await sweepTabCutOff(w.workerPool, w.clock.now())).toBe(1);
    await drain(w);
    expect((await runs("2026-09-25"))[0]!.finished).toBe(true);
    // Once finished, later ticks do nothing.
    w.clock.set(at("2026-09-26T05:10:00-04:00[America/New_York]"));
    expect(await sweepTabCutOff(w.workerPool, w.clock.now())).toBe(0);
    await drain(w);

    now = await tabs(w);
    for (const [name, cents] of [
      ["Hana K.", 4355],
      ["Jess P.", 3266],
      ["Luis M.", 6315],
      ["Tariq A.", 8601],
      ["Seat 6 · blue jacket", 1307],
    ] as const)
      expect(now[name], name).toMatchObject({
        state: "walkout_captured",
        captured: cents,
        pi_status: "succeeded",
        stripe_captures: 1,
        capture_attempts: 1,
      });
    // Each hold captured once on Stripe: one capture key per payment, whatever was killed.
    const keys = await w.owner.query<{ n: number }>(
      "select count(distinct idem_key)::int as n from payment_attempts where action = 'capture'",
    );
    expect(keys.rows[0]!.n).toBe(5);
    const closings = await w.owner.query<{ walkout: string; closed_by: string | null }>(
      "select walkout, closed_by from tab_closings where walkout is not null",
    );
    expect(closings.rows).toHaveLength(5);
    expect(closings.rows.every((x) => x.walkout === "cut_off" && x.closed_by === null)).toBe(true);
  });

  it.each([
    // Fall back: 1 AM happens twice; the cut-off is 4:30 AM EST, once.
    [
      "2026-10-31",
      "2026-11-01T09:30:00Z",
      ["2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z", "2026-11-01T09:29:59Z"],
    ],
    // Spring forward: 2 AM never happens; the cut-off is 4:30 AM EDT, once.
    [
      "2027-03-13",
      "2027-03-14T08:30:00Z",
      ["2027-03-14T06:59:00Z", "2027-03-14T07:30:00Z", "2027-03-14T08:29:59Z"],
    ],
  ])(
    "on business date %s the cut-off runs once, at 4:30 AM local time (%s)",
    async (date, due, before) => {
      for (const t of before) {
        await sweepTabCutOff(w.workerPool, Temporal.Instant.from(t));
        expect(await runs(date), t).toEqual([]);
      }
      const dueAt = Temporal.Instant.from(due);
      for (const t of [dueAt, dueAt.add({ seconds: 15 }), dueAt.add({ hours: 1 })])
        await sweepTabCutOff(w.workerPool, t);
      expect(await runs(date)).toEqual([{ due_at: due, started_at: due, finished: true }]);
      expect(
        Temporal.Instant.from(due).toZonedDateTimeISO("America/New_York").toPlainTime().toString(),
      ).toBe("04:30:00");
    },
  );
});

describe("A walkout over its hold plus the allowance", () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
    // Hana K.'s hold is $20.00 and Seat 6's $10.00, neither with overcapture: what's over goes on the
    // card saved from the first tap. Hana K.'s pays; Seat 6's declines.
    await w.owner.query(
      `update tabs set hold_cents = case name when 'Hana K.' then 2000 else 1000 end
        where name in ('Hana K.', 'Seat 6 · blue jacket')`,
    );
    await w.owner.query(
      `update payments p set overcapture_supported = false,
              generated_card_pm = case t.name when 'Hana K.' then 'pm_card_visa' else 'pm_card_chargeCustomerFail' end
         from tabs t where t.payment_id = p.id and t.name in ('Hana K.', 'Seat 6 · blue jacket')`,
    );
  });
  afterAll(async () => end(w));

  it("captures the hold, charges the rest to the saved card, or leaves the tab capture_failed and alerts Andy", async () => {
    w.clock.set(at(SAT_430));
    await sweepTabCutOff(w.workerPool, w.clock.now());
    await drain(w);
    const now = await tabs(w);
    expect(now["Hana K."]).toMatchObject({ state: "walkout_captured", captured: 2000 });
    expect(now["Seat 6 · blue jacket"]).toMatchObject({ state: "capture_failed", captured: 1000 });
    expect(now["Jess P."]).toMatchObject({ state: "walkout_captured", captured: 3266 });
    const rest = await w.owner.query<{ name: string; amount: number; status: string }>(
      `select t.name, a.amount_cents::int as amount, p.status
         from tab_closings x join tabs t on t.id = x.tab_id join payments p on p.id = x.rest_payment_id
         join payment_attempts a on a.payment_id = p.id
        order by t.name`,
    );
    expect(rest.rows.map((x) => [x.name, x.amount, x.status])).toEqual([
      ["Hana K.", 2355, "captured"],
      ["Seat 6 · blue jacket", 307, expect.stringMatching(/canceled|failed|pending/)],
    ]);
    // Hana K.'s check is paid in full by the two; Seat 6 still owes $3.07, on the manager's list.
    const due = await withVenue(w.workerPool, { venueId: w.venueId, requestId: "test" }, (c) =>
      c.query<{ name: string; due: string }>(
        `select t.name, amount_due(t.check_id, null) as due from tabs t
          where t.name in ('Hana K.', 'Seat 6 · blue jacket') order by t.name`,
      ),
    );
    expect(due.rows.map((x) => [x.name, Number(x.due)])).toEqual([
      ["Hana K.", 0],
      ["Seat 6 · blue jacket", 307],
    ]);
    const pushes = await w.owner.query<{
      payload: { audience: unknown; message: { key: string; params: unknown } };
    }>(
      "select payload from jobs where kind = 'push.send' and dedupe_key like 'tab-capture-failed:%'",
    );
    expect(pushes.rows).toHaveLength(1);
    expect(pushes.rows[0]!.payload).toMatchObject({
      audience: { kind: "person", user_id: w.ids["andy"] },
      message: {
        key: "tabs.push.captureFailed",
        params: { name: "Seat 6 · blue jacket", amount: "$3.07" },
      },
    });
    // Never retried: the next ticks leave it as it is.
    w.clock.set(at("2026-09-26T04:45:00-04:00[America/New_York]"));
    await sweepTabCutOff(w.workerPool, w.clock.now());
    await drain(w);
    expect((await tabs(w))["Seat 6 · blue jacket"]!.state).toBe("capture_failed");
  });
});
