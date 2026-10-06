import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  NIGHT_CLOSED_SQLSTATE,
  Worker,
  generateSigningKey,
  loadDemoSeed,
  publishRulePack,
  recordNightClose,
  withVenue,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, Temporal, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { Principal } from "../http/principal.js";
import { makePaymentHandlers } from "../payments/run.js";
import { StripeClient } from "../stripe/client.js";
import { FakeStripe } from "../stripe/fake/index.js";
import { fakeStripeSettings } from "../stripe/settings.js";
import { seedStripe } from "../stripe/seed-stripe.js";
import { decide } from "../approvals/service.js";
import { raiseClearOut } from "../rooms/clear-out.js";

/**
 * Closed nights (M7-02; Money rules 2 and 16; Data model · night_closes): at Sat 4:12 AM Night says the
 * three slips' tips post to Sat Sep 26; Friday closes at 4:48 AM with Z 1; Dev S.'s slip tip typed in at
 * 5:10 AM waits for Andy and, once approved, posts to Saturday pointing at Friday; after the close every
 * table with a business date refuses a row dated Friday, whoever writes it; night_closes is insert-only.
 */
let db: TestDatabase;
let owner: pg.Pool;
let appRw: pg.Pool;
let app: FastifyInstance;
let worker: Worker;
let fake: FakeStripe;
let venueId = "";
let ids: Record<string, string> = {};
const clock = new FrozenClock(SEED_NOW);
let n = 0;
let who: Principal;
const FRIDAY = "2026-09-25";
const SATURDAY = "2026-09-26";
const at = (iso: string) => Temporal.Instant.from(iso);

const as = (slug: string, role: string) => {
  who = {
    kind: "user",
    userId: ids[slug]!,
    session: role === "bartender" ? "pin" : "passkey",
    memberships: [{ venueId, membershipId: ids[`${slug}.membership`]!, role: role as never }],
  };
};
const inject = (method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/v1/venues/${venueId}${url}`,
    ...(method === "POST" ? { headers: { "idempotency-key": `key-${++n}` } } : {}),
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
async function drain() {
  for (let i = 0; i < 5; i++) while ((await worker.tick()) > 0);
}
const pgCode = (e: unknown) => (e as { code?: string }).code;

/** One statement in its own transaction, always rolled back: the error code it met, or null. */
async function attempt(pool: pg.Pool, sql: string, params: unknown[] = [], venue = true) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    if (venue) await c.query("select set_config('app.venue_id', $1, true)", [venueId]);
    await c.query(sql, params);
    return null;
  } catch (e) {
    return pgCode(e) ?? "unknown";
  } finally {
    await c.query("rollback");
    c.release();
  }
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  appRw = appPool(db.url);
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
  fake = new FakeStripe();
  const stripe = new StripeClient(fakeStripeSettings(await fake.start()), fetch, 15_000);
  await seedStripe(owner, stripe, () => undefined);
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    stripe,
    moduleCacheMs: 0,
    authenticators: [async () => who],
  });
  await app.ready();
  worker = new Worker(appRw, {
    pool: "critical",
    handlers: makePaymentHandlers({ pool: appRw, stripe, clock }),
    clock,
  });
});

afterAll(async () => {
  await app.close();
  await fake.stop();
  await appRw.end();
  await owner.end();
  await db.drop();
});

describe("Friday, before and after its close", () => {
  it("at Sat 4:12 AM, before the close, Night says the three slips' tips post to Sat Sep 26", async () => {
    clock.set(at("2026-09-26T04:12:00-04:00"));
    as("andy", "manager");
    const night = await inject("GET", `/nights/${FRIDAY}`);
    expect(night.statusCode, night.body).toBe(200);
    expect(night.json()).toMatchObject({
      business_date: FRIDAY,
      closed: null,
      late_money_posts_to: SATURDAY,
    });
    const slips = (await inject("GET", "/tabs?state=awaiting_tip")).json<{
      tabs: { name: string }[];
    }>().tabs;
    expect(slips.map((t) => t.name).sort()).toEqual(["Ana R.", "Dev S.", "Tom W."]);
    // Saturday hasn't begun: money still posts to Friday.
    expect((await inject("GET", `/nights/${SATURDAY}`)).statusCode).toBe(404);
  });

  it("Friday closes at 4:48 AM with Z 1, and Night shows it closed; Saturday has begun", async () => {
    clock.set(at("2026-09-26T04:48:00-04:00"));
    const closed = await withVenue(appRw, { venueId }, (c) =>
      recordNightClose(c, venueId, {
        businessDate: FRIDAY,
        closedAt: clock.now().toString(),
        closedBy: ids["andy"]!,
      }),
    );
    expect(closed.z_number).toBe(1);
    const night = (await inject("GET", `/nights/${FRIDAY}`)).json();
    expect(night).toMatchObject({
      closed: { z_number: 1, closed_by: ids["andy"] },
      late_money_posts_to: SATURDAY,
    });
    expect(Temporal.Instant.from(night.closed.closed_at).toString()).toBe(clock.now().toString());
    // Before the 6:00 AM cutover, the next night is the one money posts to now.
    expect((await inject("GET", `/nights/${SATURDAY}`)).statusCode).toBe(200);
    // Closed nights never reopen: a second close of Friday is refused.
    await expect(
      withVenue(appRw, { venueId }, (c) =>
        recordNightClose(c, venueId, {
          businessDate: FRIDAY,
          closedAt: clock.now().toString(),
          closedBy: ids["andy"]!,
        }),
      ),
    ).rejects.toThrow();
  });

  it("Dev S.'s slip tip at 5:10 AM waits for Andy, then posts to Sat Sep 26 pointing at Fri Sep 25", async () => {
    clock.set(at("2026-09-26T05:10:00-04:00"));
    as("maya", "bartender");
    const dev = (await inject("GET", "/tabs?state=awaiting_tip"))
      .json<{ tabs: { id: string; name: string }[] }>()
      .tabs.find((t) => t.name === "Dev S.")!;
    const r = await inject("POST", `/tabs/${dev.id}/tip`, { tip_cents: 800 });
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json()).toMatchObject({ waiting_for: { name: "Andy C." } });
    const approval = (
      await owner.query<{ reason: string }>("select reason from approvals where id = $1", [
        r.json().approval_id,
      ])
    ).rows[0]!;
    expect(approval.reason).toBe("Entered more than 2 hours after the slip");
    await withVenue(appRw, { venueId }, (c) =>
      decide(c, venueId, r.json().approval_id, {
        decision: "approve",
        userId: ids["andy"]!,
        deviceId: ids["dev_phone_andy"]!,
        at: clock.now(),
      }),
    );
    await drain();
    const p = (
      await owner.query(
        `select status, tip_cents::int as tip, business_date::text, adjusts_business_date::text as adjusts
           from payments where id = $1`,
        [ids["pay_slip_1"]],
      )
    ).rows[0];
    expect(p).toEqual({ status: "captured", tip: 800, business_date: SATURDAY, adjusts: FRIDAY });
  });

  it("Maya clocks out at 5:15 AM: her shift stays Friday's", async () => {
    clock.set(at("2026-09-26T05:15:00-04:00"));
    as("maya", "bartender");
    const r = await inject("POST", "/shifts/clock-out");
    expect(r.statusCode, r.body).toBeLessThan(300);
    const shift = (
      await owner.query(
        `select s.business_date::text, s.ended_at is not null as ended from shifts s
           join memberships m on m.id = s.membership_id where m.user_id = $1`,
        [ids["maya"]],
      )
    ).rows;
    expect(shift).toEqual([{ business_date: FRIDAY, ended: true }]);
  });

  it("the clear-out sweep after the close raises nothing for Friday, and doesn't fail", async () => {
    await expect(
      withVenue(appRw, { venueId }, (c) => raiseClearOut(c, venueId, clock.now())),
    ).resolves.toBe(false);
  });
});

describe("the closed-night guard in the database", () => {
  const tables = async () =>
    (
      await owner.query<{ t: string; guarded: boolean }>(
        `select c.table_name as t,
                exists (select 1 from pg_trigger g where g.tgrelid = ('public.' || c.table_name)::regclass
                          and g.tgname = 'closed_night_guard') as guarded
           from information_schema.columns c
           join information_schema.tables x using (table_schema, table_name)
          where c.table_schema = 'public' and c.column_name = 'business_date'
            and x.table_type = 'BASE TABLE' and c.table_name <> 'night_closes'
          order by 1`,
      )
    ).rows;

  it("guards every table with a business date (a new one needs the trigger too)", async () => {
    const all = await tables();
    expect(all.length).toBeGreaterThanOrEqual(19);
    expect(all.filter((t) => !t.guarded).map((t) => t.t)).toEqual([]);
  });

  it("after the close, an insert dated Fri Sep 25 fails on every one, as app_rw or as the owner", async () => {
    for (const { t } of await tables()) {
      const sql = `insert into ${t} (venue_id, business_date) values ($1, $2)`;
      let code = await attempt(appRw, sql, [venueId, FRIDAY]);
      // A table app_rw can't insert into directly (a definer function writes it): the owner tries.
      if (code === "42501") code = await attempt(owner, sql, [venueId, FRIDAY], false);
      expect([t, code]).toEqual([t, NIGHT_CLOSED_SQLSTATE]);
      // The same row dated Saturday meets the table's own rules instead, never the guard.
      expect([t, await attempt(owner, sql, [venueId, SATURDAY], false)]).not.toEqual([
        t,
        NIGHT_CLOSED_SQLSTATE,
      ]);
    }
  });

  it("an update that moves a row onto Friday fails; rows already on Friday can still change", async () => {
    expect(
      await attempt(appRw, "update payments set business_date = $2 where id = $1", [
        ids["pay_slip_1"],
        FRIDAY,
      ]),
    ).toBe(NIGHT_CLOSED_SQLSTATE);
    const friday = (
      await owner.query<{ id: string }>("select id from shifts where business_date = $1 limit 1", [
        FRIDAY,
      ])
    ).rows[0]!;
    expect(
      await attempt(appRw, "update shifts set updated_at = now() where id = $1", [friday.id]),
    ).toBeNull();
  });

  it("app_rw can't update, delete or truncate a night_closes row", async () => {
    for (const sql of [
      "update night_closes set z_number = 99",
      "update night_closes set totals = '{}'::jsonb",
      "delete from night_closes",
      "truncate night_closes",
    ])
      expect([sql, await attempt(appRw, sql)]).toEqual([sql, "42501"]);
    expect(
      (await owner.query("select z_number::int as z from night_closes")).rows.map((r) => r.z),
    ).toEqual([1]);
  });

  it("posting_business_date steps past Friday, and past Saturday too once it closes", async () => {
    const posting = async (iso: string) =>
      (
        await withVenue(appRw, { venueId }, (c) =>
          c.query<{ d: string }>("select posting_business_date($1, $2)::text as d", [venueId, iso]),
        )
      ).rows[0]!.d;
    expect(await posting("2026-09-26T05:59:00-04:00")).toBe(SATURDAY);
    expect(await posting("2026-09-25T23:00:00-04:00")).toBe(SATURDAY);
    await withVenue(appRw, { venueId }, (c) =>
      recordNightClose(c, venueId, {
        businessDate: SATURDAY,
        closedAt: "2026-09-27T08:50:00Z",
        closedBy: ids["andy"]!,
      }),
    );
    expect(await posting("2026-09-25T23:00:00-04:00")).toBe("2026-09-27");
    expect(
      (await owner.query("select z_number::int as z from night_closes order by z")).rows,
    ).toEqual([{ z: 1 }, { z: 2 }]);
  });
});
