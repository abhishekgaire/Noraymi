import {
  emitEvent,
  nightClose,
  postingDate,
  recordNightClose,
  recordPunch,
  type Queryable,
} from "@west4/db";
import type { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { venueClock } from "../rooms/assignment.js";
import { closePool, poolOf } from "../tips/pool.js";
import { nightChecks } from "./checks.js";
import { postNightExport } from "./journal.js";
import { computeReport } from "./report.js";

/** Who closes the night: an owner or manager, or our staff on the emergency path (M8-11). */
export type Closer =
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "support"; readonly staffId: string; readonly name: string };

export interface ClosedNight {
  readonly business_date: string;
  readonly z_number: number;
  readonly closed_at: string;
  readonly closed_by: string | null;
  readonly checks: { rooms: number; bar_tabs: number };
}

/**
 * Close the night (M7-12), inside the caller's venue transaction: every check runs again; then the
 * next Z number and `night_closes` with the Z totals, the tip pool closed, unsent drafts and 86s
 * cleared, the closing manager clocked out, and `night.closed`. Two closes at once: one wins.
 *
 * On the emergency path (M8-11) our staff member closes it: nobody is exempt from "on the clock"
 * and nobody is clocked out by the close, so every blocking check (an uncounted drawer, an open
 * tab, an open room, a shift left open) refuses it exactly as it refuses a manager.
 */
export async function closeNight(
  c: Queryable,
  input: { venueId: string; date: string; now: Temporal.Instant; by: Closer },
): Promise<ClosedNight> {
  const { venueId, date, now, by } = input;
  if (date !== (await postingDate(c, venueId, now)))
    throw new ApiError("invalid_request", "only tonight's business date closes");
  await c.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `night-close:${venueId}:${date}`,
  ]);
  if (await nightClose(c, venueId, date))
    throw new ApiError("version_conflict", "this night is already closed");
  const exempt = by.kind === "user" ? by.userId : null;
  const failing = (await nightChecks(c, venueId, date, now, exempt)).filter((x) => x.blocking);
  if (failing.length > 0)
    throw new ApiError("night_open", "the night can't close yet", {
      details: { checks: failing.map((x) => ({ id: x.id, count: x.count, names: x.names })) },
    });
  if (by.kind === "user") {
    // The closing manager clocks out at the close.
    const own = await c.query<{ id: string }>(
      "select id from memberships where venue_id = $1 and user_id = $2",
      [venueId, by.userId],
    );
    const open = await c.query(
      "select 1 from shifts where venue_id = $1 and membership_id = $2 and ended_at is null",
      [venueId, own.rows[0]!.id],
    );
    if ((open.rowCount ?? 0) > 0)
      await recordPunch(c, {
        venueId,
        membershipId: own.rows[0]!.id,
        kind: "clock_out",
        at: now,
        venue: await venueClock(c, venueId),
      });
  }
  // The tip pool closes with the night: its shares are written once (M7-09).
  await poolOf(c, venueId, date);
  await closePool(c, venueId, date, now);
  // Rooms and bar tabs counted apart.
  const counts = (
    await c.query<{ rooms: number; bar_tabs: number }>(
      `select count(*) filter (where kind = 'room')::int as rooms, count(*) filter (where kind = 'bar')::int as bar_tabs
         from checks where venue_id = $1 and business_date = $2::date and not training and status <> 'void'`,
      [venueId, date],
    )
  ).rows[0]!;
  // The Z report (M7-13), worked out once now and stored with the close: never recomputed.
  const closer =
    by.kind === "user"
      ? ((await c.query<{ name: string }>("select name from users where id = $1", [by.userId]))
          .rows[0]?.name ?? null)
      : by.name;
  const z = await computeReport(c, venueId, date, now, "z");
  const byId = by.kind === "user" ? by.userId : by.staffId;
  // The night's accounting journal, posted from the same lines (M7-15), and its file.
  const exportId = await postNightExport(c, venueId, { date, report: z, userId: byId });
  const closed = await recordNightClose(c, venueId, {
    businessDate: date,
    closedAt: now.toString(),
    closedBy: by.kind === "user" ? by.userId : null,
    closedBySupport: by.kind === "support" ? by.staffId : null,
    exportId,
    totals: {
      checks: counts,
      report: { ...z, closed: { z_number: 0, closed_at: now.toString(), closed_by: closer } },
    },
  });
  // Unsent drinks left are cleared, and tonight's 86s end.
  await c.query(
    "update order_drafts set lines = '[]', version = version + 1, updated_at = $2 where venue_id = $1 and jsonb_array_length(lines) > 0",
    [venueId, now.toString()],
  );
  await c.query(
    "update venues set kitchen_closed_until = null, kitchen_closed_by = null where id = $1",
    [venueId],
  );
  for (const table of ["menu_items", "menu_variants", "menu_options"])
    await c.query(`update ${table} set out_until = null where venue_id = $1 and out_until > $2`, [
      venueId,
      now.toString(),
    ]);
  await emitEvent(c, { venueId, type: "menu.changed", entityId: venueId });
  await emitEvent(c, { venueId, type: "night.closed", entityId: venueId });
  return {
    business_date: date,
    z_number: closed.z_number,
    closed_at: closed.closed_at,
    closed_by: closed.closed_by,
    checks: counts,
  };
}

/** A named fix on a stuck night (M8-11's cautious default), each with its reason. */
export interface NightFixInput {
  readonly kind: "clock_out_shift" | "clear_draft" | "expire_approval";
  readonly id: string;
  readonly reason: string;
}

/** Where an approval's target lives, and when it's gone: missing, or no longer open. */
const TARGETS: Record<string, string> = {
  session: "select 1 from room_sessions where venue_id = $1 and id = $2 and ended_at is null",
  check: "select 1 from checks where venue_id = $1 and id = $2 and status not in ('paid', 'void')",
  check_line: "select 1 from check_lines where venue_id = $1 and id = $2",
  tab: "select 1 from tabs where venue_id = $1 and id = $2",
  order: "select 1 from orders where venue_id = $1 and id = $2",
  payment: "select 1 from payments where venue_id = $1 and id = $2",
  drawer_session: "select 1 from drawer_sessions where venue_id = $1 and id = $2",
  drawer_handover: "select 1 from drawer_handovers where venue_id = $1 and id = $2",
};

/**
 * Applies the stale-item fixes our staff may make before closing a stuck night: clock out a
 * shift left open, clear a stale draft, expire an approval whose target is gone. Anything else,
 * or a fix whose item isn't stale, refuses the whole close.
 */
export async function applyNightFixes(
  c: Queryable,
  venueId: string,
  fixes: readonly NightFixInput[],
  now: Temporal.Instant,
): Promise<void> {
  for (const fix of fixes) {
    if (fix.kind === "clock_out_shift") {
      const shift = await c.query<{ membership_id: string }>(
        "select membership_id from shifts where venue_id = $1 and id = $2 and ended_at is null",
        [venueId, fix.id],
      );
      if (!shift.rows[0])
        throw new ApiError("invalid_request", "that shift isn't open", {
          details: { fix: fix.kind, id: fix.id },
        });
      await recordPunch(c, {
        venueId,
        membershipId: shift.rows[0].membership_id,
        kind: "clock_out",
        at: now,
        venue: await venueClock(c, venueId),
      });
    } else if (fix.kind === "clear_draft") {
      const r = await c.query(
        "update order_drafts set lines = '[]', version = version + 1, updated_at = $3 where venue_id = $1 and id = $2 and jsonb_array_length(lines) > 0",
        [venueId, fix.id, now.toString()],
      );
      if (r.rowCount !== 1)
        throw new ApiError("invalid_request", "that draft is already empty", {
          details: { fix: fix.kind, id: fix.id },
        });
    } else {
      const a = await c.query<{ target_kind: string; target_id: string }>(
        "select target_kind, target_id from approvals where venue_id = $1 and id = $2 and status = 'pending'",
        [venueId, fix.id],
      );
      const row = a.rows[0];
      if (!row)
        throw new ApiError("invalid_request", "that approval isn't waiting", {
          details: { fix: fix.kind, id: fix.id },
        });
      const sql = TARGETS[row.target_kind];
      const live = sql ? ((await c.query(sql, [venueId, row.target_id])).rowCount ?? 0) > 0 : true;
      if (live)
        throw new ApiError("invalid_request", "that approval's target is still there", {
          details: { fix: fix.kind, id: fix.id },
        });
      await c.query(
        "update approvals set status = 'expired', decided_at = $3 where venue_id = $1 and id = $2 and status = 'pending'",
        [venueId, fix.id, now.toString()],
      );
    }
  }
}
