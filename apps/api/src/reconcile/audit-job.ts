import { enqueue, isNightClosed, type JobHandler, type Queryable, type Schedule } from "@west4/db";
import type { MoneyError } from "@west4/rules";
import type { Temporal } from "@west4/shared";
import { enqueueEmail } from "../jobs/send-email.js";
import type { EmailSettings } from "../email/settings.js";
import { isAllowed } from "../email/policy.js";
import { venueToday } from "../licenses/licenses.js";
import { raisePage } from "../ops/paging.js";
import { auditNight, type MoneyAudit } from "./audit.js";

/**
 * The morning money audit (M9-15): every venue, every morning on its own clock, audits the night that
 * just ended (the previous business date: its close, and the payouts that arrived on it) with
 * auditNight, keeps the result in `money_audits`, pages us on any money error (rule `money-error`,
 * docs/runbooks/money-error.md) and emails the morning summary to the venue's owners and to our
 * founder (`MONEY_AUDIT_TO`, comma-separated, from the environment; nobody when it's unset). The pages
 * and emails go out from their own jobs and sweep, outside this transaction.
 */
export const MONEY_AUDIT_KIND = "money.audit";

/** 8:00 AM: after the close (the night ends by the 6:00 AM cutover) and before the day's work. */
export const moneyAuditSchedule: Schedule = {
  kind: MONEY_AUDIT_KIND,
  at: "08:00",
  pool: "bulk",
  maxAttempts: 10,
};

/** Our founder's address(es) for the morning summary, from the environment only. */
export function moneyAuditTo(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env["MONEY_AUDIT_TO"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[^@\s]+@[^@\s]+$/.test(s));
}

export interface MorningResult {
  readonly night: string;
  readonly audit: MoneyAudit | null;
  readonly skipped?: "no_night";
  readonly emailed: number;
  readonly paged: boolean;
}

/** Keeps one audit of a night, with its errors (amounts and ids only). */
export async function recordAudit(
  c: Queryable,
  venueId: string,
  audit: MoneyAudit,
  trigger: "morning" | "manual",
  now: Temporal.Instant,
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `insert into money_audits (venue_id, night, ran_at, trigger, ok, covered, errors)
     values ($1, $2::date, $3, $4, $5, $6, $7) returning id`,
    [
      venueId,
      audit.night,
      now.toString(),
      trigger,
      audit.ok,
      audit.covered,
      JSON.stringify(audit.errors),
    ],
  );
  return r.rows[0]!.id;
}

/** A night with no close and no money at all (the venue was shut) has nothing to audit. */
async function hadANight(c: Queryable, venueId: string, night: string): Promise<boolean> {
  if (await isNightClosed(c, venueId, night)) return true;
  const r = await c.query(
    `select 1 from live_checks where venue_id = $1 and business_date = $2::date
     union all
     select 1 from live_payments where venue_id = $1 and business_date = $2::date
     limit 1`,
    [venueId, night],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function runMorningAudit(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
  email: Pick<EmailSettings, "allowList">,
  founder: readonly string[],
): Promise<MorningResult> {
  const today = await venueToday(c, venueId, now);
  const night = today.subtract({ days: 1 }).toString();
  if (!(await hadANight(c, venueId, night)))
    return { night, audit: null, skipped: "no_night", emailed: 0, paged: false };
  const audit = await auditNight(c, venueId, night, now);
  const id = await recordAudit(c, venueId, audit, "morning", now);
  const venueName = (
    await c.query<{ name: string }>("select name from venues where id = $1", [venueId])
  ).rows[0]!.name;

  let paged = false;
  if (!audit.ok) {
    const made = await raisePage(
      c,
      {
        rule: "money-error",
        key: `money-error:${venueId}:${night}`,
        summary: `${audit.errors.length} money errors at ${venueName} on the night of ${night}`,
      },
      now,
    );
    paged = made?.opened ?? false;
  }

  // The morning summary: the venue's owners in their own language, our founder in English.
  const owners = (
    await c.query<{ email: string | null; locale: "en" | "es" }>(
      `select u.email, m.locale from memberships m join users u on u.id = m.user_id
        where m.venue_id = $1 and m.role = 'owner' and m.status = 'active' order by u.name`,
      [venueId],
    )
  ).rows;
  const to = [
    ...owners.filter((o) => o.email).map((o) => ({ email: o.email!, locale: o.locale })),
    ...founder.map((f) => ({ email: f, locale: "en" as const })),
  ];
  const items = audit.errors.slice(0, 20).map((e: MoneyError) => ({
    kind: e.kind,
    ref: (e.ref ?? night).slice(0, 80),
    diffCents: e.diffCents ?? null,
  }));
  let emailed = 0;
  for (const r of to) {
    if (!isAllowed(email.allowList, r.email)) continue;
    await enqueueEmail(c, email, {
      venueId,
      to: r.email,
      locale: r.locale,
      template: "money_audit",
      data: { venueName, night, errorCount: audit.errors.length, items },
      runAt: now,
      dedupeKey: `money-audit:${venueId}:${night}:${r.email}`,
    });
    emailed++;
  }
  await c.query("update money_audits set summary_sent_at = $3 where venue_id = $1 and id = $2", [
    venueId,
    id,
    now.toString(),
  ]);
  return { night, audit, emailed, paged };
}

export function makeMoneyAuditHandler(
  email: Pick<EmailSettings, "allowList">,
  founder: readonly string[] = moneyAuditTo(),
): JobHandler {
  return async ({ job, clock, step }) => {
    // The venue comes from the job row, never the payload.
    await step((c) => runMorningAudit(c, job.venue_id, clock.now(), email, founder));
  };
}

/** For tests and the wall suite: queue this morning's audit for one venue. */
export async function enqueueMoneyAudit(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
): Promise<string | null> {
  return enqueue(c, { venueId, kind: MONEY_AUDIT_KIND, pool: "bulk", runAt: now, payload: {} });
}
