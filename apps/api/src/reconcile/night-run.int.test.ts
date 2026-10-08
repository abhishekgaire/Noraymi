import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  LOCAL_DEV_AUTH_KEY as KEY,
  generateSigningKey,
  loadDemoSeed,
  publishRulePack,
  withVenue,
} from "@west4/db";
import { appPool, createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import { FrozenClock, SEED_NOW, Temporal, newYorkCounty, newYorkCountyTaxed } from "@west4/shared";
import { buildApp } from "../app.js";
import { reconcileNight } from "./night.js";
import { auditNight, type MoneyAudit } from "./audit.js";
import { runMorningAudit } from "./audit-job.js";
import { moneyErrorRows } from "./money-error-log.js";
import { playNight, type NightClient } from "./runner.js";
import { loadConfig } from "../config.js";
import "../payments/webhooks.js";
import type { Principal, SessionKind } from "../http/principal.js";

/**
 * The night runner and the reconcile script in CI's one-night compressed mode (M7-19): the demo seed's
 * Friday played to its close through the API only, then reconciled to the cent. Runs with the integration
 * suite on every merge, so any money change that breaks a figure fails here, naming the night and rule.
 */
let db: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let api: FastifyInstance;
let venueId: string;
let ids: Record<string, string>;
const clock = new FrozenClock(SEED_NOW);
let n = 0;

type Role = "owner" | "manager" | "bartender" | "front_desk";
interface Who {
  slug: string;
  role: Role;
  session: SessionKind;
  device: string;
  deviceKind: "bar_computer" | "front_desk" | "staff_phone";
}
let who: Who;
const as = (slug: string, role: Role, session: SessionKind, device: string) => {
  who = {
    slug,
    role,
    session,
    device,
    deviceKind: device.startsWith("dev_phone")
      ? "staff_phone"
      : device === "dev_bar_computer"
        ? "bar_computer"
        : "front_desk",
  };
};

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  owner = new pg.Pool({ connectionString: db.url });
  app = appPool(db.url);
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
  const memberships = Object.fromEntries(
    (
      await owner.query<{ user_id: string; id: string }>(
        "select user_id, id from memberships where venue_id = $1",
        [venueId],
      )
    ).rows.map((r) => [r.user_id, r.id]),
  );
  as("andy", "manager", "passkey", "dev_phone_andy");
  api = buildApp({
    config: loadConfig({
      WEST4_ENV: "local",
      DATABASE_URL: db.url,
      APP_DATABASE_URL: db.url,
      AUTH_SECRET_KEY: KEY,
    }),
    clock,
    moduleCacheMs: 0,
    authenticators: [
      async (request: FastifyRequest): Promise<Principal> => {
        const userId = ids[who.slug]!;
        const deviceId = ids[who.device]!;
        Object.assign(request, {
          session: {
            assurance: who.session,
            membershipId: memberships[userId],
            deviceId,
          },
          signedDevice: { deviceId, venueId, kind: who.deviceKind },
        });
        return {
          kind: "user",
          userId,
          session: who.session,
          memberships: [{ venueId, membershipId: memberships[userId]!, role: who.role }],
        };
      },
    ],
  });
  await api.ready();
});

afterAll(async () => {
  await api.close();
  await app.end();
  await owner.end();
  await db.drop();
});

const client: NightClient = {
  async call(actor, method, path, body) {
    as(actor.who, actor.role, actor.session, actor.device);
    const r = await api.inject({
      method,
      url: `/v1/venues/${venueId}${path}`,
      headers: { "idempotency-key": `run-${++n}` },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    return { status: r.statusCode, json: r.body ? (r.json() as Record<string, unknown>) : {} };
  },
  async setClock(iso) {
    clock.set(Temporal.Instant.from(iso));
  },
};

describe("a night, played and reconciled", () => {
  it("plays the seed's Friday to its close through the API and reconciles it to the cent", async () => {
    const steps = await playNight(client, "2026-09-25");
    expect(steps.at(-1)).toEqual({ step: "close", status: 200 });
    const result = await withVenue(app, { venueId }, (c) =>
      reconcileNight(c, venueId, "2026-09-25", clock.now()),
    );
    expect(result.differences).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checked).toEqual([
      "z_report",
      "drawers",
      "tip_ledger",
      "tip_pool",
      "payouts",
      "journals",
      "practice",
    ]);
  });

  it("the money audit (M9-15) finds the clean night clean, every amount covered", async () => {
    const result = await withVenue(app, { venueId }, (c) =>
      auditNight(c, venueId, "2026-09-25", clock.now()),
    );
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.covered).toEqual(
      expect.arrayContaining(["z_report", "drawers", "tip_ledger", "payouts", "journals"]),
    );
    expect(result.covered).toEqual(
      expect.arrayContaining(["checks", "charges", "refunds", "card_fee (off)"]),
    );
  });

  /** A fault written behind the app's back, audited in the same transaction, then rolled back. */
  async function withFault(
    fault: (c: pg.PoolClient, paid: { id: string; number: string }) => Promise<void>,
  ): Promise<MoneyAudit> {
    const c = await owner.connect();
    try {
      await c.query("begin");
      // Past the closed-night guard, as a bug or a hand edit would be: triggers off for this transaction.
      await c.query("set local session_replication_role = replica");
      const paid = (
        await c.query<{ id: string; number: string }>(
          `select id, number::text from checks where venue_id = $1 and business_date = '2026-09-25'
              and status = 'paid' and kind = 'room' and not training order by number limit 1`,
          [venueId],
        )
      ).rows[0]!;
      await fault(c, paid);
      return await auditNight(c, venueId, "2026-09-25", clock.now());
    } finally {
      await c.query("rollback");
      c.release();
    }
  }
  const lineFault = (c: pg.PoolClient, checkId: string, kind: string, cents: number) =>
    c.query(
      `insert into check_lines (venue_id, check_id, kind, description, unit_cents, amount_cents, business_date)
       values ($1, $2, $3, 'fault', $4, $4, '2026-09-25')`,
      [venueId, checkId, kind, cents],
    );

  it("catches a tax line a cent off", async () => {
    const r = await withFault((c, paid) => lineFault(c, paid.id, "tax", 1));
    expect(r.ok).toBe(false);
    expect(r.errors).toContainEqual(
      expect.objectContaining({ kind: "tax", diffCents: 1, night: "2026-09-25" }),
    );
  });

  it("catches a double charge", async () => {
    let ref = "";
    const r = await withFault(async (c, paid) => {
      ref = `#${paid.number}`;
      const p = (
        await c.query<{ id: string }>(
          `insert into payments (venue_id, method, status, amount_cents, business_date)
           values ($1, 'external', 'captured', 5000, '2026-09-25') returning id`,
          [venueId],
        )
      ).rows[0]!.id;
      await c.query(
        `insert into payment_allocations (venue_id, payment_id, check_id, amount_cents, kind, state)
         values ($1, $2, $3, 5000, 'payment', 'captured')`,
        [venueId, p, paid.id],
      );
    });
    expect(r.errors).toContainEqual(
      expect.objectContaining({ kind: "charge", ref, diffCents: 5000 }),
    );
  });

  it("catches a refund over its cap", async () => {
    const r = await withFault(async (c) => {
      const p = (
        await c.query<{ id: string; check_id: string; captured: string }>(
          `select p.id, a.check_id, (p.amount_cents + p.tip_cents + p.surcharge_cents)::text as captured
             from payments p join payment_allocations a on a.venue_id = p.venue_id and a.payment_id = p.id
            where p.venue_id = $1 and p.business_date = '2026-09-25' and p.status = 'captured'
              and not p.training and a.kind = 'payment' and a.state = 'captured'
              and not exists (select 1 from refunds r where r.payment_id = p.id)
            order by p.created_at limit 1`,
          [venueId],
        )
      ).rows[0]!;
      await c.query(
        `insert into refunds (venue_id, payment_id, check_id, amount_cents, reason, status, n, requested_by,
                              business_date, requested_at)
         values ($1, $2, $3, $4, 'fault', 'succeeded', 1, $5, '2026-09-25', now())`,
        [venueId, p.id, p.check_id, Number(p.captured) + 1, ids["andy"]],
      );
    });
    expect(r.errors).toContainEqual(expect.objectContaining({ kind: "refund", diffCents: 1 }));
  });

  it("catches a drawer count that doesn't reconcile", async () => {
    const r = await withFault(async (c) => {
      const s = (
        await c.query<{ id: string }>(
          `select s.id from drawer_sessions s join cash_drawers d on d.id = s.drawer_id
            where d.name = 'Bar drawer' and s.business_date = '2026-09-25' limit 1`,
        )
      ).rows[0]!.id;
      await c.query(
        "insert into drawer_moves (venue_id, drawer_session_id, kind, amount_cents, taken_by, at) values ($1, $2, 'paid_out', 1, $3, now())",
        [venueId, s, ids["andy"]],
      );
    });
    expect(r.errors).toContainEqual(expect.objectContaining({ kind: "drawer" }));
  });

  const morning = Temporal.Instant.from("2026-09-26T12:00:00Z"); // 8:00 AM in New York
  const allowAll = { allowList: null };

  it("the morning audit keeps a clean night's result, pages nobody and emails the owner the summary", async () => {
    const r = await withVenue(app, { venueId }, (c) =>
      runMorningAudit(c, venueId, morning, allowAll, ["founder@example.test"]),
    );
    expect(r).toMatchObject({ night: "2026-09-25", paged: false });
    expect(r.audit?.ok).toBe(true);
    const kept = await owner.query<{ ok: boolean; trigger: string; sent: boolean }>(
      `select ok, trigger, summary_sent_at is not null as sent from money_audits
        where venue_id = $1 and night = '2026-09-25'`,
      [venueId],
    );
    expect(kept.rows).toEqual([{ ok: true, trigger: "morning", sent: true }]);
    const mails = await owner.query<{ to: string; template: string; errors: number }>(
      `select payload ->> 'to' as to, payload ->> 'template' as template,
              (payload -> 'data' ->> 'errorCount')::int as errors
         from jobs where kind = 'email.send' and payload ->> 'template' = 'money_audit'`,
    );
    expect(mails.rows.map((m) => m.to)).toContain("founder@example.test");
    expect(mails.rows.length).toBe(r.emailed);
    expect(mails.rows.length).toBeGreaterThanOrEqual(2); // the owner and the founder
    for (const m of mails.rows) expect(m.errors).toBe(0);
    const pages = await owner.query("select 1 from pages where rule = 'money-error'");
    expect(pages.rowCount).toBe(0);
  });

  it("a money error pages us once, and its log rows name the night and the difference", async () => {
    const c = await owner.connect();
    try {
      await c.query("begin");
      await c.query("set local session_replication_role = replica");
      const paid = (
        await c.query<{ id: string }>(
          `select id from checks where venue_id = $1 and business_date = '2026-09-25' and status = 'paid'
              and kind = 'room' and not training order by number limit 1`,
          [venueId],
        )
      ).rows[0]!;
      await lineFault(c, paid.id, "tax", 1);
      const r = await runMorningAudit(c, venueId, morning, allowAll, []);
      expect(r.paged).toBe(true);
      expect(r.audit?.ok).toBe(false);
      const page = await c.query<{ summary: string; runbook: string }>(
        "select summary, runbook from pages where rule = 'money-error'",
      );
      expect(page.rows).toEqual([
        expect.objectContaining({ runbook: "docs/runbooks/money-error.md" }),
      ]);
      expect(page.rows[0]!.summary).toMatch(/money errors .* on the night of 2026-09-25/);
      // A rerun the same morning doesn't page twice.
      expect((await runMorningAudit(c, venueId, morning, allowAll, [])).paged).toBe(false);
      const rows = moneyErrorRows(venueId, r.audit!);
      expect(rows).toMatch(/^\| 2026-09-25 \| .* \| tax \| #\d+ \| .* \| 1 \| {2}\| {2}\| {2}\|$/m);
    } finally {
      await c.query("rollback");
      c.release();
    }
  });

  it("a night the venue was shut is skipped", async () => {
    const r = await withVenue(app, { venueId }, (c) =>
      runMorningAudit(c, venueId, Temporal.Instant.from("2026-09-20T12:00:00Z"), allowAll, []),
    );
    expect(r).toMatchObject({ night: "2026-09-19", audit: null, skipped: "no_night" });
  });

  it("names the night and the rule when a cent is off", async () => {
    // A drawer move written behind the count's back: its expected cash no longer matches.
    const s = (
      await owner.query<{ id: string }>(
        "select s.id from drawer_sessions s join cash_drawers d on d.id = s.drawer_id where d.name = 'Bar drawer' and s.business_date = '2026-09-25' limit 1",
      )
    ).rows[0]!.id;
    await owner.query(
      "insert into drawer_moves (venue_id, drawer_session_id, kind, amount_cents, taken_by, at) values ($1, $2, 'paid_out', 1, $3, now())",
      [venueId, s, ids["andy"]],
    );
    const result = await withVenue(app, { venueId }, (c) =>
      reconcileNight(c, venueId, "2026-09-25", clock.now()),
    );
    expect(result.ok).toBe(false);
    // Its stored expected cash and its count both disagree with the moves now: each named.
    expect(result.differences.length).toBeGreaterThan(0);
    for (const d of result.differences)
      expect(d).toMatchObject({ rule: "drawers", night: "2026-09-25" });
  });
});
