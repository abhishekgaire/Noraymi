import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed } from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { SEED_NOW, SimulatedClock, type Temporal } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { FakeMailer } from "../email/mailer.js";
import type { Principal } from "../http/principal.js";
import { sweepQuietDevices } from "../jobs/device-watch.js";
import { FakeTextSender } from "../texts/sender.js";
import { runAlertSweep } from "./alert-sweep.js";
import { notifyPages, raisePage, setRota, type PagerDeps } from "./paging.js";
import { makeSnsSigner } from "./sns-fixture.js";

/**
 * M8-17 on the demo seed at Fri 10:41 PM (open): alert rules under forced conditions, the
 * escalation to the second responder, the alarm hook and the Console's Pages.
 */
let db: TestDatabase;
let raw: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let venueId = "";
let firstId = "";
const clock = new SimulatedClock(SEED_NOW);
const mailer = new FakeMailer();
const texts = new FakeTextSender();
const pager: PagerDeps = { mailer, texts, from: "pages@west4.test", consoleUrl: "http://console" };
const TOPIC = "arn:aws:sns:us-east-1:123:west4-staging-pages";
const signer = makeSnsSigner();
const confirmed: string[] = [];

const sweep = (now: Temporal.Instant = clock.now()) => runAlertSweep(pool, pager, now);
const livePages = async (rule: string) =>
  (
    await raw.query<{ id: string; key: string; severity: string }>(
      "select id, key, severity from pages where rule = $1 and cleared_at is null",
      [rule],
    )
  ).rows;
const resetPages = async () => {
  await raw.query("delete from page_notifications");
  await raw.query("delete from pages");
  mailer.sent.length = 0;
  texts.sent.length = 0;
};

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  pool = appPool(db.url);
  const staff = await raw.query<{ id: string }>(
    `insert into console_staff (name, email) values ('Ana', 'ana@oncall.test'), ('Ben', 'ben@oncall.test')
     returning id`,
  );
  firstId = staff.rows[0]!.id;
  const consolePrincipal: Principal = {
    kind: "console",
    staffId: firstId,
    name: "Ana",
    email: "ana@oncall.test",
  } as Principal;
  app = buildApp({
    config: loadConfig({
      WEST4_ENV: "local",
      DATABASE_URL: db.url,
      APP_DATABASE_URL: db.url,
      CONSOLE_URL: "http://localhost:5174",
    }),
    clock,
    authenticators: [async () => consolePrincipal],
    moduleCacheMs: 0,
    alarmHook: {
      topicArn: TOPIC,
      getCert: signer.getCert,
      confirm: async (url) => void confirmed.push(url),
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await raw.end();
  await db.drop();
});

beforeEach(async () => {
  clock.set(SEED_NOW);
  await resetPages();
});

describe("the on-call rota and the escalation (M8-17)", () => {
  it("starts empty: a page is recorded but sent to nobody", async () => {
    await raisePage(
      pool,
      { rule: "test-page", key: "test-page:empty", summary: "x", test: true },
      clock.now(),
    );
    const r = await notifyPages(pool, pager, clock.now());
    expect(r.rotaEmpty).toBe(true);
    expect(r.sent).toEqual([]);
  });

  it("a test page nobody acknowledges in 10 minutes reaches the second responder", async () => {
    await setRota(pool, "first", "ana@oncall.test", null, "test");
    await setRota(pool, "second", "ben@oncall.test", "+12125550100", "test");
    const opened = clock.now();
    const page = await raisePage(
      pool,
      {
        rule: "test-page",
        key: "test-page:escalate",
        summary: "Test page from the suite",
        test: true,
      },
      opened,
    );
    await notifyPages(pool, pager, opened);
    expect(mailer.sent.map((m) => m.to)).toEqual(["ana@oncall.test"]);
    expect(texts.sent).toHaveLength(0);

    // 9:59 later: still only Ana, and nothing sent twice.
    await notifyPages(pool, pager, opened.add({ minutes: 9, seconds: 59 }));
    expect(mailer.sent).toHaveLength(1);

    // 10 minutes unacknowledged: Ben by email and text.
    await notifyPages(pool, pager, opened.add({ minutes: 10 }));
    expect(mailer.sent.map((m) => m.to)).toEqual(["ana@oncall.test", "ben@oncall.test"]);
    expect(mailer.sent[1]!.subject).toContain("Not acknowledged in 10 minutes");
    expect(texts.sent.map((t) => t.to)).toEqual(["+12125550100"]);
    expect(texts.sent[0]!.idempotencyKey).toBe(`page:${page!.page.id}:second:text`);

    // Later sweeps send nothing new.
    await notifyPages(pool, pager, opened.add({ minutes: 30 }));
    expect(mailer.sent).toHaveLength(2);
    expect(texts.sent).toHaveLength(1);
  });

  it("a page acknowledged in the Console within 10 minutes never reaches the second", async () => {
    const opened = clock.now();
    const page = await raisePage(
      pool,
      { rule: "test-page", key: "test-page:acked", summary: "Acked test", test: true },
      opened,
    );
    await notifyPages(pool, pager, opened);
    clock.set(opened.add({ minutes: 4 }));
    const list = await app.inject({ method: "GET", url: "/v1/console/pages" });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json<{ rota: { name: string }[] }>().rota.map((r) => r.name)).toEqual([
      "Ana",
      "Ben",
    ]);
    const ack = await app.inject({
      method: "POST",
      url: `/v1/console/pages/${page!.page.id}/ack`,
      payload: {},
    });
    expect(ack.statusCode, ack.body).toBe(200);
    const again = await app.inject({
      method: "POST",
      url: `/v1/console/pages/${page!.page.id}/ack`,
      payload: {},
    });
    expect(again.statusCode).toBe(409);
    await notifyPages(pool, pager, opened.add({ minutes: 15 }));
    expect(mailer.sent.map((m) => m.to)).toEqual(["ana@oncall.test"]);
  });

  it("a failed send is retried by the next sweep under the same key", async () => {
    await raisePage(
      pool,
      { rule: "test-page", key: "test-page:retry", summary: "Retry", test: true },
      clock.now(),
    );
    mailer.failWith = new Error("smtp down");
    const first = await notifyPages(pool, pager, clock.now());
    expect(first.failed).toBe(1);
    mailer.failWith = null;
    await notifyPages(pool, pager, clock.now());
    expect(mailer.sent).toHaveLength(1);
  });
});

describe("alert rules under forced conditions", () => {
  const devices = async (kind: string) =>
    (
      await raw.query<{ id: string }>(
        "select id from devices where venue_id = $1 and kind = $2 and not training and revoked_at is null and disabled_at is null order by name",
        [venueId, kind],
      )
    ).rows.map((r) => r.id);
  const heartbeat = async (ids: string[], at: Temporal.Instant, offline: boolean) => {
    for (const id of ids)
      await raw.query(
        `insert into device_heartbeats (device_id, venue_id, last_seen_at, offline_since) values ($1, $2, $3, $4)
         on conflict (device_id) do update set last_seen_at = excluded.last_seen_at, offline_since = excluded.offline_since`,
        [id, venueId, at.toString(), offline ? at.toString() : null],
      );
  };

  it("one quiet room tablet only alerts the manager; both readers offline during opening hours pages us", async () => {
    const now = clock.now();
    const everything = (
      await raw.query<{ id: string }>("select id from devices where venue_id = $1", [venueId])
    ).rows.map((r) => r.id);
    await heartbeat(everything, now, false);
    const tablet = (await devices("room_tablet"))[0]!;
    await raw.query("update device_heartbeats set last_seen_at = $2 where device_id = $1", [
      tablet,
      now.subtract({ minutes: 3 }).toString(),
    ]);
    const quiet = await sweepQuietDevices(pool, now);
    expect(quiet[0]?.offline).toEqual([tablet]);
    const toManager = await raw.query(
      "select 1 from venue_events where venue_id = $1 and type = 'device.offline' and entity_id = $2",
      [venueId, tablet],
    );
    expect(toManager.rowCount).toBe(1);
    await sweep(now);
    expect(await raw.query("select 1 from pages")).toMatchObject({ rowCount: 0 });

    const readers = await devices("reader");
    expect(readers.length).toBe(2);
    await heartbeat(readers.slice(0, 1), now, true);
    await sweep(now);
    expect(await livePages("readers-offline")).toHaveLength(0);
    await heartbeat(readers, now, true);
    await sweep(now);
    expect((await livePages("readers-offline")).map((p) => p.key)).toEqual([
      `readers-offline:${venueId}`,
    ]);
    // One reader back: the page clears.
    await heartbeat(readers.slice(1), now, false);
    await sweep(now);
    expect(await livePages("readers-offline")).toHaveLength(0);
    await heartbeat(everything, now, false);
  });

  it("both readers offline outside opening hours pages nobody", async () => {
    const closed = SEED_NOW.add({ hours: 12 }); // Saturday 10:41 AM
    await heartbeat(await devices("reader"), closed, true);
    await sweep(closed);
    expect(await livePages("readers-offline")).toHaveLength(0);
    await heartbeat(await devices("reader"), closed, false);
  });

  it("a payout that doesn't reconcile pages us, once", async () => {
    await raw.query(
      `insert into payouts (venue_id, stripe_payout_id, account, amount_cents, arrival_date, reconciled)
       values ($1, 'po_test_off', 'acct_test', 12345, '2026-09-27', false)`,
      [venueId],
    );
    await sweep();
    const live = await livePages("payout-unreconciled");
    expect(live.map((p) => p.key)).toEqual(["payout-unreconciled:po_test_off"]);
    await sweep();
    expect(
      (await raw.query("select 1 from pages where rule = 'payout-unreconciled'")).rowCount,
    ).toBe(1);
    // Acknowledged, it's over and never pages again for that payout.
    await raw.query(
      "update pages set acked_at = $1, acked_by = $2, cleared_at = $1 where id = $3",
      [clock.now().toString(), firstId, live[0]!.id],
    );
    await sweep();
    expect(
      (await raw.query("select 1 from pages where rule = 'payout-unreconciled'")).rowCount,
    ).toBe(1);
    await raw.query("delete from payouts where stripe_payout_id = 'po_test_off'");
  });

  it("a dead money job pages us and clears when it's requeued", async () => {
    const job = await raw.query<{ id: string }>(
      `insert into jobs (venue_id, kind, pool, run_at, status, last_error)
       values ($1, 'payment.run', 'critical', $2, 'dead', 'timeout') returning id`,
      [venueId, clock.now().toString()],
    );
    await sweep();
    expect(await livePages("money-dead-letters")).toHaveLength(1);
    await raw.query("update jobs set status = 'done' where id = $1", [job.rows[0]!.id]);
    await sweep();
    expect(await livePages("money-dead-letters")).toHaveLength(0);
  });

  it("a Stripe webhook unprocessed for over a minute pages us", async () => {
    await raw.query(
      `insert into webhook_events (venue_id, provider, event_id, type, received_at)
       values ($1, 'stripe', 'evt_lag', 'payment_intent.succeeded', $2)`,
      [venueId, clock.now().subtract({ seconds: 61 }).toString()],
    );
    await sweep();
    expect(await livePages("webhook-lag")).toHaveLength(1);
    await raw.query("update webhook_events set processed_at = now() where event_id = 'evt_lag'");
    await sweep();
    expect(await livePages("webhook-lag")).toHaveLength(0);
  });

  it("a swept tab whose capture failed pages us", async () => {
    const tc = await raw.query<{ id: string; tab_id: string; state: string }>(
      `select tc.id, tc.tab_id, t.state from tab_closings tc join tabs t on t.id = tc.tab_id
        where tc.venue_id = $1 limit 1`,
      [venueId],
    );
    const row = tc.rows[0]!;
    await raw.query("update tab_closings set swept_at = $2 where id = $1", [
      row.id,
      clock.now().toString(),
    ]);
    await raw.query("update tabs set state = 'capture_failed' where id = $1", [row.tab_id]);
    await sweep();
    expect(await livePages("capture-sweep-failed")).toHaveLength(1);
    await raw.query("update tabs set state = $2 where id = $1", [row.tab_id, row.state]);
    await raw.query("update tab_closings set swept_at = null where id = $1", [row.id]);
    await sweep();
    expect(await livePages("capture-sweep-failed")).toHaveLength(0);
  });

  it("card payments failing on our side page us; declined cards don't", async () => {
    const pay = await raw.query<{ id: string }>(
      `insert into payments (venue_id, method, status, business_date) values ($1, 'card_present', 'pending', '2026-09-25')
       returning id`,
      [venueId],
    );
    const at = clock.now().subtract({ minutes: 2 }).toString();
    const attempt = (no: number, state: string, code: string | null) =>
      raw.query(
        `insert into payment_attempts (venue_id, payment_id, attempt_no, portion_key, action, idem_key, amount_cents, state, decline_code, started_at, resolved_at)
         values ($1, $2, $3, 'full', 'process', $4, 1000, $5, $6, $7, $7)`,
        [venueId, pay.rows[0]!.id, no, `${pay.rows[0]!.id}:process:${no}`, state, code, at],
      );
    for (let i = 1; i <= 9; i++) await attempt(i, "succeeded", null);
    await attempt(10, "failed", "card_declined");
    await sweep();
    expect(await livePages("payment-failures")).toHaveLength(0);
    await attempt(11, "failed", "api_connection_error");
    await sweep();
    expect(await livePages("payment-failures")).toHaveLength(1);
    await raw.query("delete from payment_attempts where payment_id = $1", [pay.rows[0]!.id]);
    await sweep();
    expect(await livePages("payment-failures")).toHaveLength(0);
  });
});

describe("the alarm hook (CloudWatch and RDS through the pages topic)", () => {
  const post = (body: unknown) =>
    app.inject({
      method: "POST",
      url: "/v1/hooks/alarms",
      headers: { "content-type": "text/plain; charset=UTF-8" },
      payload: JSON.stringify(body),
    });
  const alarm = (state: string, id = "a-1") =>
    signer.sign({
      Type: "Notification",
      MessageId: id,
      TopicArn: TOPIC,
      Timestamp: "2026-09-26T02:41:00.000Z",
      Message: JSON.stringify({
        AlarmName: "west4-staging-target-burn-payments-fast",
        AlarmDescription: "rule:target-burn runbook:docs/runbooks/target-burn.md · payments",
        NewStateValue: state,
      }),
    });

  it("confirms the subscription, pages on ALARM during opening hours and clears on OK", async () => {
    const sub = signer.sign({
      Type: "SubscriptionConfirmation",
      MessageId: "s-1",
      TopicArn: TOPIC,
      Timestamp: "2026-09-26T02:41:00.000Z",
      Message: "confirm",
      Token: "tok",
      SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=tok",
    });
    expect((await post(sub)).statusCode).toBe(200);
    expect(confirmed).toHaveLength(1);

    const res = await post(alarm("ALARM"));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ severity: "page" });
    expect(await livePages("target-burn")).toHaveLength(1);
    expect((await post(alarm("OK", "a-2"))).statusCode).toBe(200);
    expect(await livePages("target-burn")).toHaveLength(0);
  });

  it("outside opening hours a burn alarm is a ticket that wakes nobody", async () => {
    clock.set(SEED_NOW.add({ hours: 12 }));
    expect((await post(alarm("ALARM", "a-3"))).json()).toMatchObject({ severity: "ticket" });
    const r = await notifyPages(pool, pager, clock.now());
    expect(r.sent).toEqual([]);
  });

  it("a database failover pages once per event", async () => {
    const failover = signer.sign({
      Type: "Notification",
      MessageId: "rds-1",
      TopicArn: TOPIC,
      Timestamp: "2026-09-26T02:41:00.000Z",
      Message: JSON.stringify({
        "Event Source": "db-instance",
        "Source ID": "west4-staging",
        "Event Message": "Multi-AZ instance failover completed",
      }),
    });
    await post(failover);
    await post(failover);
    expect(await livePages("db-failover")).toHaveLength(1);
  });

  it("refuses an unsigned or altered message, or another topic", async () => {
    expect((await post({ ...alarm("ALARM", "x"), Message: "{}" })).statusCode).toBe(401);
    expect((await post({ ...alarm("ALARM", "y"), TopicArn: "arn:other" })).statusCode).toBe(401);
    expect((await post({ hello: "world" })).statusCode).toBe(401);
    expect(await raw.query("select 1 from pages")).toMatchObject({ rowCount: 0 });
  });
});
