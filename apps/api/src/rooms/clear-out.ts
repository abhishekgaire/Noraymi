import type pg from "pg";
import { emitEvent, withVenue, type Queryable, type Sweep } from "@west4/db";
import { businessDate, clearOutDue } from "@west4/rules";
import type { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { managerOnDutyAt } from "../approvals/service.js";
import { enqueuePush } from "../push/send-push.js";
import { alcoholVenue } from "../orders/alcohol.js";

/**
 * The clear-out check (M3-23; screens N17; Money rules 5). Each business
 * date, at the alcohol window's close plus drinking-up time (M3-01: 4:30 AM
 * at West 4), it's raised once: `clear_out.due` to the board and Close the
 * night, and a push to the manager on duty. The board asks "Walk every room
 * and the bar · no drinks left out" with Done, which records who and when.
 */
export const CLEAR_OUT_EVERY_MS = 15_000;

export async function raiseClearOut(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
): Promise<boolean> {
  const venue = await alcoholVenue(c, venueId, now);
  // The check belongs to the business date whose close it follows: 4:30 AM Saturday is Friday's.
  const date = businessDate(now, venue.timeZone, venue.dayCutover).businessDate;
  const due = clearOutDue(venue, date);
  if (now.epochMilliseconds < due.epochMilliseconds) return false;
  const r = await c.query(
    `insert into clear_out_checks (venue_id, business_date, due_at) values ($1, $2, $3)
     on conflict (venue_id, business_date) do nothing returning id`,
    [venueId, date.toString(), due.toString()],
  );
  if ((r.rowCount ?? 0) === 0) return false;
  await emitEvent(c, {
    venueId,
    type: "clear_out.due",
    entityId: date.toString(),
    entityVersion: 0,
  });
  const manager = await managerOnDutyAt(c, venueId, now);
  if (manager)
    await enqueuePush(c, {
      venueId,
      audience: { kind: "person", userId: manager },
      message: {
        key: "clearOut.push",
        params: {},
        url: "/tonight",
        tag: `clear-out-${date.toString()}`,
      },
      runAt: now,
    });
  return true;
}

export async function sweepClearOut(pool: pg.Pool, now: Temporal.Instant): Promise<number> {
  const venues = await pool.query<{ id: string }>("select id from venues_for_scheduler()");
  let raised = 0;
  for (const v of venues.rows)
    if (
      await withVenue(pool, { venueId: v.id, requestId: "sweep:clear-out" }, (c) =>
        raiseClearOut(c, v.id, now),
      )
    )
      raised++;
  return raised;
}

export function clearOutSweep(pool: pg.Pool): Sweep {
  return {
    name: "night.clear-out",
    everyMs: CLEAR_OUT_EVERY_MS,
    run: async (now) => void (await sweepClearOut(pool, now)),
  };
}

/** Tonight's check, for the board: due and waiting, or done by whom and when. */
export async function clearOutFor(c: Queryable, venueId: string, date: string) {
  const r = await c.query<{
    business_date: string;
    due_at: string;
    done_at: string | null;
    done_by_name: string | null;
  }>(
    `select k.business_date::text, to_json(k.due_at) #>> '{}' as due_at, to_json(k.done_at) #>> '{}' as done_at,
            (select split_part(u.name, ' ', 1) from users u where u.id = k.done_by) as done_by_name
       from clear_out_checks k where k.venue_id = $1 and k.business_date = $2`,
    [venueId, date],
  );
  return r.rows[0] ?? null;
}

export async function markClearOut(
  c: Queryable,
  venueId: string,
  input: { date: string; userId: string; note: string | null; now: Temporal.Instant },
) {
  const r = await c.query(
    `update clear_out_checks set done_by = $3, done_at = $4, note = $5
      where venue_id = $1 and business_date = $2 and done_at is null`,
    [venueId, input.date, input.userId, input.now.toString(), input.note],
  );
  if ((r.rowCount ?? 0) === 0) {
    const exists = await clearOutFor(c, venueId, input.date);
    if (!exists)
      throw new ApiError("not_found", "the clear-out check isn't due yet for that night");
    throw new ApiError("version_conflict", "the clear-out check is already done");
  }
  await emitEvent(c, { venueId, type: "clear_out.done", entityId: input.date, entityVersion: 0 });
  return clearOutFor(c, venueId, input.date);
}
