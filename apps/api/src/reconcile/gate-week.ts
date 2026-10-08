import { enqueue, type JobHandler, type Queryable, type Schedule } from "@west4/db";
import { gateStreak, type GateStreak } from "@west4/rules";
import { enqueueEmail } from "../jobs/send-email.js";
import type { EmailSettings } from "../email/settings.js";
import { isAllowed } from "../email/policy.js";
import { venueToday } from "../licenses/licenses.js";
import { moneyAuditTo } from "./audit-job.js";
import type { Temporal } from "@west4/shared";

/**
 * The gate's count and its weekly summary (M9-17). Each night counts by its morning audits in
 * `money_audits`: a night any audit found a money error in is an error night, even when a rerun after
 * the fix is clean, because the error happened. Every Monday at 8:30 AM on the venue's clock, once
 * the venue has a live night, the summary goes to its owners and to our founder (`MONEY_AUDIT_TO`).
 */
export const GATE_WEEK_KIND = "gate.weekly";

export const gateWeekSchedule: Schedule = {
  kind: GATE_WEEK_KIND,
  at: "08:30",
  pool: "bulk",
  maxAttempts: 10,
};

export async function gateCount(c: Queryable, venueId: string): Promise<GateStreak> {
  const r = await c.query<{ night: string; ok: boolean }>(
    `select to_char(night, 'YYYY-MM-DD') as night, bool_and(ok) as ok from money_audits
      where venue_id = $1 group by night order by night`,
    [venueId],
  );
  return gateStreak(r.rows);
}

export async function sendGateWeek(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
  email: Pick<EmailSettings, "allowList">,
  founder: readonly string[],
  opts: { anyDay?: boolean } = {},
): Promise<{ sent: number; streak: GateStreak | null }> {
  const today = await venueToday(c, venueId, now);
  if (!opts.anyDay && today.dayOfWeek !== 1) return { sent: 0, streak: null };
  const weekEnding = today.subtract({ days: 1 });
  const any = await c.query("select 1 from money_audits where venue_id = $1 limit 1", [venueId]);
  if (!any.rowCount) return { sent: 0, streak: null }; // no live night yet
  const streak = await gateCount(c, venueId);
  const errorsThisWeek = Number(
    (
      await c.query<{ n: string }>(
        `select count(distinct night)::text as n from money_audits
          where venue_id = $1 and not ok and night > $2::date and night <= $3::date`,
        [venueId, weekEnding.subtract({ days: 7 }).toString(), weekEnding.toString()],
      )
    ).rows[0]!.n,
  );
  const venueName = (
    await c.query<{ name: string }>("select name from venues where id = $1", [venueId])
  ).rows[0]!.name;
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
  let sent = 0;
  for (const r of to) {
    if (!isAllowed(email.allowList, r.email)) continue;
    await enqueueEmail(c, email, {
      venueId,
      to: r.email,
      locale: r.locale,
      template: "gate_week",
      data: {
        venueName,
        weekEnding: weekEnding.toString(),
        cleanNights: streak.cleanNights,
        runStartedOn: streak.runStartedOn,
        lastErrorOn: streak.lastErrorOn,
        daysToGo: streak.daysToGo,
        met: streak.met,
        errorsThisWeek,
      },
      runAt: now,
      dedupeKey: `gate-week:${venueId}:${weekEnding.toString()}:${r.email}`,
    });
    sent++;
  }
  return { sent, streak };
}

export function makeGateWeekHandler(
  email: Pick<EmailSettings, "allowList">,
  founder: readonly string[] = moneyAuditTo(),
): JobHandler {
  return async ({ job, clock, step }) => {
    // The venue comes from the job row, never the payload.
    await step((c) => sendGateWeek(c, job.venue_id, clock.now(), email, founder));
  };
}

/** For tests and the wall suite. */
export async function enqueueGateWeek(c: Queryable, venueId: string, now: Temporal.Instant) {
  return enqueue(c, { venueId, kind: GATE_WEEK_KIND, pool: "bulk", runAt: now, payload: {} });
}
