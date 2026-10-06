import type { Queryable } from "@west4/db";
import type { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import type { StaffLine } from "../orders/place.js";
import { sendRound, type SendAnswer } from "./hold.js";

/**
 * Send the singer a drink (M6-24; spec 11 · Send the singer a drink; API · `POST /tabs/{t}/gift-order`;
 * D64): a gift order from the sender's open tab, naming the singer and the singer's check (their bar
 * tab, if they have one). It goes through the tab's hold check like any round, so it can raise the
 * hold or wait for a manager, rings the bar and prints a ticket naming the singer with "check ID at
 * hand-off". The one alcohol check runs on the sender's tab and again on the singer's: a cut-off
 * singer, or the window closed, answers `409 cut_off` or `409 alcohol_closed`, logged.
 */
export async function giftOrder(
  c: Queryable,
  venueId: string,
  input: {
    tabId: string;
    singerId: string;
    lines: readonly StaffLine[];
    clientOrderId: string | null;
    userId: string;
    membershipId: string;
    deviceId: string | null;
    now: Temporal.Instant;
    raised?: boolean;
  },
): Promise<SendAnswer> {
  const tab = (
    await c.query<{ check_id: string; state: string }>(
      "select check_id, state from tabs where venue_id = $1 and id = $2",
      [venueId, input.tabId],
    )
  ).rows[0];
  if (!tab) throw new ApiError("not_found", "no such tab");
  if (tab.state !== "open") throw new ApiError("invalid_request", "this tab isn't open");
  const singer = (
    await c.query<{ id: string; check_id: string | null }>(
      "select id, check_id from singers where venue_id = $1 and id = $2",
      [venueId, input.singerId],
    )
  ).rows[0];
  if (!singer) throw new ApiError("not_found", "no such singer");
  return sendRound(c, venueId, {
    checkId: tab.check_id,
    lines: input.lines,
    clientOrderId: input.clientOrderId,
    userId: input.userId,
    membershipId: input.membershipId,
    deviceId: input.deviceId,
    now: input.now,
    ...(input.raised ? { raised: true } : {}),
    gift: { singerId: singer.id, checkId: singer.check_id },
  });
}
