import { emitEvent, type Queryable } from "@west4/db";
import { businessDate } from "@west4/rules";
import { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import {
  declineHandlers,
  executors,
  requestApproval,
  TargetGone,
  type ApprovalAnswer,
} from "../approvals/service.js";
import { venueClock } from "../rooms/assignment.js";

/**
 * A missed sale on tonight's date (P-19; Money rules 16; module missed_sale, off by default). A sale
 * nobody rang up on an earlier night is rung up tonight on a bar tab marked "From the night of
 * <date>" with a reason. Its lines are ordinary lines of tonight's business date, so it counts on
 * tonight's Z report; closed nights never reopen (D88), so that night's totals don't change. The Z
 * report lists it with the night it came from. A manager asks (owners and managers, the same people
 * as a refund), and it's written once approved per the venue's approval setting (phone, PIN or none).
 * One stands on a check at a time; it comes off while the check is open, before payment. Both are
 * in the audit log. Replaces the old register's past-dated manual ticket.
 */
export interface MissedSalePayload {
  readonly check_id: string;
  readonly from_date: string;
  readonly reason: string;
}

interface StandingMissedSale {
  readonly id: string;
  readonly from_date: string;
  readonly reason: string;
  readonly added_by_name: string | null;
  readonly approved_by_name: string | null;
}

async function standingMissedSale(
  c: Queryable,
  venueId: string,
  checkId: string,
): Promise<StandingMissedSale | null> {
  const r = await c.query<StandingMissedSale>(
    `select m.id, m.from_date::text, m.reason, u.name as added_by_name, a.name as approved_by_name
       from check_missed_sales m
       left join users u on u.id = m.added_by
       left join users a on a.id = m.approved_by
      where m.venue_id = $1 and m.check_id = $2 and m.removed_at is null`,
    [venueId, checkId],
  );
  return r.rows[0] ?? null;
}

async function lockCheck(c: Queryable, venueId: string, checkId: string) {
  const locked = await c.query<{ status: string; kind: string; business_date: string }>(
    "select status, kind, business_date::text from checks where venue_id = $1 and id = $2 for update",
    [venueId, checkId],
  );
  return locked.rows[0] ?? null;
}

async function tonight(c: Queryable, venueId: string, at: Temporal.Instant): Promise<string> {
  const v = await venueClock(c, venueId);
  return businessDate(at, v.timeZone, v.dayCutover).businessDate.toString();
}

/** Asks for a bar tab to be marked a missed sale from an earlier night: it waits per the venue's setting. */
export async function askMissedSale(
  c: Queryable,
  venueId: string,
  input: {
    checkId: string;
    fromDate: string;
    reason: string;
    userId: string;
    deviceId: string | null;
    now: Temporal.Instant;
  },
): Promise<ApprovalAnswer> {
  const reason = input.reason.trim();
  if (!reason)
    throw new ApiError("invalid_request", "a missed sale needs a reason", {
      details: { reason: "reason_missing" },
    });
  let from: Temporal.PlainDate;
  try {
    from = Temporal.PlainDate.from(input.fromDate, { overflow: "reject" });
  } catch {
    throw new ApiError("invalid_request", "the night it came from is a date, YYYY-MM-DD", {
      details: { reason: "date_invalid" },
    });
  }
  const night = await tonight(c, venueId, input.now);
  if (Temporal.PlainDate.compare(from, Temporal.PlainDate.from(night)) >= 0)
    throw new ApiError(
      "invalid_request",
      "a missed sale comes from an earlier night than tonight",
      {
        details: { reason: "date_not_earlier", tonight: night },
      },
    );
  const check = await lockCheck(c, venueId, input.checkId);
  if (!check) throw new ApiError("not_found", "no such check");
  if (check.kind !== "bar")
    throw new ApiError("invalid_request", "a missed sale is rung up on a bar tab");
  if (check.status !== "open")
    throw new ApiError(
      "ordering_closed",
      "this check is closed; once it's paid, a correction is a refund",
    );
  if (check.business_date !== night)
    throw new ApiError("invalid_request", "a missed sale is rung up on a tab opened tonight", {
      details: { reason: "tab_not_tonight" },
    });
  if (await standingMissedSale(c, venueId, input.checkId))
    throw new ApiError("invalid_request", "this tab is already a missed sale", {
      details: { reason: "missed_sale_standing" },
    });
  const pending = await c.query(
    `select 1 from approvals where venue_id = $1 and status = 'pending' and kind = 'missed_sale'
        and target_id = $2`,
    [venueId, input.checkId],
  );
  if (pending.rowCount)
    throw new ApiError(
      "approval_pending",
      "this tab is already waiting to be marked a missed sale",
    );
  const payload: MissedSalePayload = {
    check_id: input.checkId,
    from_date: from.toString(),
    reason,
  };
  const asked = await requestApproval(c, venueId, {
    kind: "missed_sale",
    targetKind: "check",
    targetId: input.checkId,
    amountCents: null,
    reason: `Missed sale · From the night of ${from.toString()} · ${reason}`,
    payload: { ...payload, description: `Missed sale · From the night of ${from.toString()}` },
    requestedBy: input.userId,
    requestedDeviceId: input.deviceId,
    now: input.now,
  });
  await emitEvent(c, { venueId, type: "check.updated", entityId: input.checkId, entityVersion: 0 });
  return asked;
}

/** Takes the mark off an open tab (before payment); its lines stay tonight's either way. */
export async function removeMissedSale(
  c: Queryable,
  venueId: string,
  input: { checkId: string; userId: string; now: Temporal.Instant },
): Promise<void> {
  const check = await lockCheck(c, venueId, input.checkId);
  if (!check) throw new ApiError("not_found", "no such check");
  if (check.status !== "open")
    throw new ApiError(
      "ordering_closed",
      "this check is closed; once it's paid, a correction is a refund",
    );
  const m = await standingMissedSale(c, venueId, input.checkId);
  if (!m) throw new ApiError("not_found", "this tab isn't a missed sale");
  await c.query(
    "update check_missed_sales set removed_by = $3, removed_at = $4 where venue_id = $1 and id = $2",
    [venueId, m.id, input.userId, input.now.toString()],
  );
  await emitEvent(c, { venueId, type: "check.updated", entityId: input.checkId, entityVersion: 0 });
}

/** What the check view shows: the missed sale standing on it, or one waiting for approval. */
export async function missedSaleView(c: Queryable, venueId: string, checkId: string) {
  const m = await standingMissedSale(c, venueId, checkId);
  const waiting = (
    await c.query<{ name: string; payload: MissedSalePayload }>(
      `select u.name, a.payload from approvals a join users u on u.id = a.routed_to
        where a.venue_id = $1 and a.target_id = $2 and a.status = 'pending' and a.kind = 'missed_sale'
        limit 1`,
      [venueId, checkId],
    )
  ).rows[0];
  return {
    missed_sale: m
      ? {
          from_date: m.from_date,
          reason: m.reason,
          added_by: m.added_by_name,
          approved_by: m.approved_by_name,
        }
      : null,
    pending_missed_sale: waiting
      ? { waiting_for: waiting.name, from_date: waiting.payload.from_date }
      : null,
  };
}

/** Approved: the mark is written as asked, dated tonight, if the tab is still open and has none. */
executors.set("missed_sale", async (c, venueId, approval, ctx) => {
  const p = approval.payload as unknown as MissedSalePayload;
  const check = await lockCheck(c, venueId, p.check_id);
  if (!check || check.status !== "open" || (await standingMissedSale(c, venueId, p.check_id)))
    throw new TargetGone();
  await c.query(
    `insert into check_missed_sales (venue_id, check_id, business_date, from_date, reason, added_by,
       added_at, approved_by)
     values ($1, $2, $3::date, $4::date, $5, $6, $7, $8)`,
    [
      venueId,
      p.check_id,
      check.business_date,
      p.from_date,
      p.reason,
      approval.requested_by,
      ctx.at.toString(),
      ctx.approverId,
    ],
  );
  await emitEvent(c, { venueId, type: "check.updated", entityId: p.check_id, entityVersion: 0 });
});

/** Declined: nothing changes, but every screen showing the tab drops "Waiting for Andy". */
declineHandlers.set("missed_sale", async (c, venueId, approval) => {
  const p = approval.payload as { check_id?: string };
  if (!p.check_id) return;
  await emitEvent(c, { venueId, type: "check.updated", entityId: p.check_id, entityVersion: 0 });
});

/** One missed sale on a night's Z report: the tab, the night it came from, why, and its sales. */
export interface MissedSale {
  readonly check: string;
  readonly where: string;
  readonly from_date: string;
  readonly reason: string;
  readonly asked_by: string | null;
  readonly approved_by: string | null;
  /** The tab's sales before tax and gratuity (items, fees, comps, voids and discounts). */
  readonly sales_cents: number;
}

/** The missed sales rung up on a night (its checks' business date), practice left out. */
export async function missedSalesOfNight(
  c: Queryable,
  venueId: string,
  date: string,
): Promise<{ sales_cents: number; checks: MissedSale[] }> {
  const rows = (
    await c.query<{
      check: string;
      where: string;
      from_date: string;
      reason: string;
      asked_by: string | null;
      approved_by: string | null;
      cents: string;
    }>(
      `select '#' || k.number as check,
              coalesce((select t.name from tabs t where t.venue_id = k.venue_id and t.check_id = k.id),
                       '#' || k.number) as where,
              m.from_date::text, m.reason, ru.name as asked_by, au.name as approved_by,
              (select coalesce(sum(l.amount_cents), 0) from live_check_lines l
                where l.venue_id = k.venue_id and l.check_id = k.id
                  and l.kind in ('room_time', 'item', 'song', 'fee', 'damage', 'min_spend', 'comp',
                                 'void', 'discount'))::text as cents
         from check_missed_sales m
         join live_checks k on k.venue_id = m.venue_id and k.id = m.check_id
         left join users ru on ru.id = m.added_by
         left join users au on au.id = m.approved_by
        where m.venue_id = $1 and m.removed_at is null and k.business_date = $2::date
        order by m.from_date, k.number`,
      [venueId, date],
    )
  ).rows;
  const checks = rows.map((r) => ({
    check: r.check,
    where: r.where,
    from_date: r.from_date,
    reason: r.reason,
    asked_by: r.asked_by,
    approved_by: r.approved_by,
    sales_cents: Number(r.cents),
  }));
  return { sales_cents: checks.reduce((sum, x) => sum + x.sales_cents, 0), checks };
}
