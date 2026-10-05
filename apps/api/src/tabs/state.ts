import type { Queryable } from "@west4/db";
import { canMoveTab, isTabState, type TabState } from "@west4/shared";
import { ApiError } from "../http/errors.js";

/**
 * The one function every tab move goes through (M6-06; Payment flows · Bar tab
 * with a growing hold, the state diagram): the tab's row is locked, and only
 * a move the diagram allows is written. Opening inserts a tab as `open`;
 * closing, tips, walkouts, moves to a room and reopening (M6-08 onwards) all
 * call this. Answers the state before the move.
 */
export async function moveTab(
  c: Queryable,
  venueId: string,
  tabId: string,
  to: TabState,
): Promise<TabState> {
  const r = await c.query<{ state: string }>(
    "select state from tabs where venue_id = $1 and id = $2 for update",
    [venueId, tabId],
  );
  const from = r.rows[0]?.state;
  if (!from || !isTabState(from)) throw new ApiError("not_found", "no such tab");
  if (!canMoveTab(from, to))
    throw new ApiError("invalid_request", `a ${from} tab can't become ${to}`, {
      details: { reason: "tab_state", from, to },
    });
  if (from !== to)
    await c.query("update tabs set state = $3 where venue_id = $1 and id = $2", [
      venueId,
      tabId,
      to,
    ]);
  return from;
}
