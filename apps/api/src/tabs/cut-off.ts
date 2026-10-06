import { emitEvent, type Queryable } from "@west4/db";
import { businessDate } from "@west4/rules";
import type { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { cancelAlcohol } from "../rooms/cut-off.js";
import { venueClock } from "../rooms/assignment.js";

/**
 * Cutting off a bar tab (M6-14; screens N16; Money rules 5): it records who, when and why on the
 * tab and logs a refusal in `alcohol_refusals`. From then on the tab's check takes no alcohol
 * (the one alcohol check reads the tab's cut-off: sends, repeat rounds, moves and gift orders
 * answer `409 cut_off`), and any alcohol order for it still ringing or asked to wait is cancelled
 * as `cut_off`. Singing is still fine. Like a room's, a tab's cut-off isn't lifted (the spec has none).
 */
export async function cutOffTab(
  c: Queryable,
  venueId: string,
  input: { tabId: string; userId: string; reason: string; now: Temporal.Instant },
): Promise<{
  cut_off: { at: string; by: string | null; reason: string };
  cancelled: number;
}> {
  const r = await c.query<{ check_id: string; state: string; cut: boolean }>(
    `select check_id, state, cut_off_at is not null as cut from tabs
      where venue_id = $1 and id = $2 for update`,
    [venueId, input.tabId],
  );
  const tab = r.rows[0];
  if (!tab) throw new ApiError("not_found", "no such tab");
  if (tab.cut) throw new ApiError("version_conflict", "this tab is already cut off");
  // Only a tab still running can be cut off: a settled one takes nothing more anyway.
  if (!["open", "tipping", "awaiting_tip"].includes(tab.state))
    throw new ApiError("version_conflict", "this tab is settled", {
      details: { reason: "tab_state", state: tab.state },
    });
  await c.query(
    `update tabs set cut_off_at = $3, cut_off_by = $4, cut_off_reason = $5
      where venue_id = $1 and id = $2`,
    [venueId, input.tabId, input.now.toString(), input.userId, input.reason],
  );
  const v = await venueClock(c, venueId);
  await c.query(
    `insert into alcohol_refusals (venue_id, check_id, reason, refused_by, at, business_date)
     values ($1, $2, 'cut_off', $3, $4, $5)`,
    [
      venueId,
      tab.check_id,
      input.userId,
      input.now.toString(),
      businessDate(input.now, v.timeZone, v.dayCutover).businessDate.toString(),
    ],
  );
  const cancelled = await cancelAlcohol(
    c,
    venueId,
    { sessionId: null, roomGuestId: null, checkId: tab.check_id },
    input.userId,
    input.now,
  );
  await emitEvent(c, { venueId, type: "tab.updated", entityId: input.tabId });
  const by = await c.query<{ name: string }>(
    "select split_part(name, ' ', 1) as name from users where id = $1",
    [input.userId],
  );
  return {
    cut_off: { at: input.now.toString(), by: by.rows[0]?.name ?? null, reason: input.reason },
    cancelled,
  };
}
