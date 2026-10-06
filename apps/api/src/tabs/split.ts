import { emitEvent, endSplit, openSplit, type Queryable, type SplitRow } from "@west4/db";
import type { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { finalizeCheck } from "../rooms/finalize.js";
import { startSplit } from "../payments/splits.js";

/**
 * Split a bar tab (M6-10; Payment flows · Bar tab step 8; Money rules 1 and
 * 13; Staff screens and the bar POS · Split): evenly 2, 3 or 4 ways, kept on
 * the server in M4-14's `check_splits` and `split_shares`, so a paid share
 * survives leaving the pay panel and switching tabs. The tab's check is
 * finalized (it takes no more drinks while split) and the tab stays `open`
 * until the last share is paid. Shares are paid by a new tap or in cash
 * through POST /checks/{c}/payments with their share_id; the held card's
 * share is captured last, by Close to the card, with its tip on the reader,
 * so the hold keeps guaranteeing the rest until then.
 */
export async function splitTab(
  c: Queryable,
  venueId: string,
  tabId: string,
  shares: number,
  by: { userId: string; now: Temporal.Instant },
): Promise<SplitRow> {
  const r = await c.query<{ state: string; check_id: string; status: string }>(
    `select t.state, t.check_id, k.status from tabs t join checks k on k.venue_id = t.venue_id and k.id = t.check_id
      where t.venue_id = $1 and t.id = $2 for update of t`,
    [venueId, tabId],
  );
  const tab = r.rows[0];
  if (!tab) throw new ApiError("not_found", "no such tab");
  if (tab.state !== "open")
    throw new ApiError("invalid_request", `this tab is ${tab.state}`, {
      details: { reason: "tab_state", state: tab.state },
    });
  if (await openSplit(c, venueId, tab.check_id))
    throw new ApiError("in_progress", "this tab is split already");
  if (tab.status === "open" || tab.status === "reopened") {
    await finalizeCheck(c, venueId, tab.check_id, { userId: by.userId, now: by.now });
    await c.query("update checks set status = 'finalized' where venue_id = $1 and id = $2", [
      venueId,
      tab.check_id,
    ]);
  }
  // Something may have been paid already (a share of a split that was stopped): it stays partly paid.
  await c.query(
    `update checks set status = 'partly_paid' where venue_id = $1 and id = $2 and status = 'finalized'
        and exists (select 1 from payment_allocations a join tabs t on t.venue_id = a.venue_id and t.check_id = a.check_id
                     where a.venue_id = $1 and a.check_id = $2 and a.state = 'captured'
                       and a.payment_id is distinct from t.payment_id)`,
    [venueId, tab.check_id],
  );
  const split = await startSplit(c, venueId, tab.check_id, { kind: "even", shares }, by);
  await emitEvent(c, { venueId, type: "tab.updated", entityId: tabId });
  return split;
}

/**
 * Where a Close stands with the tab's open split: none; the held card's turn (one share left, now being
 * paid by the Close); or, for a charge with no tip (a walkout, Charge the remaining tabs), the split ends
 * with its paid shares kept and the hold takes the rest. Refused while other shares are still to pay.
 */
export async function splitAtClose(
  c: Queryable,
  venueId: string,
  checkId: string,
  path: "reader" | "slip" | "none",
  by: { userId: string; now: Temporal.Instant },
): Promise<void> {
  const split = await openSplit(c, venueId, checkId);
  if (!split) return;
  if (split.shares.some((s) => s.state === "paying"))
    throw new ApiError("in_progress", "a share is being paid right now", {
      details: { reason: "share_paying" },
    });
  const open = split.shares.filter((s) => s.state === "open");
  if (path === "none") {
    await endSplit(c, venueId, split.id, by.userId, by.now.toString());
    return;
  }
  if (open.length !== 1)
    throw new ApiError("invalid_request", "pay the other shares first", {
      details: { reason: "split_shares_left", open: open.length },
    });
  await c.query("update split_shares set state = 'paying' where venue_id = $1 and id = $2", [
    venueId,
    open[0]!.id,
  ]);
}

/** After a Close: the held card's share is paid when the hold is captured, or open again when it isn't. */
export async function settleHeldShare(
  c: Queryable,
  venueId: string,
  checkId: string,
  outcome: "paid" | "open",
): Promise<void> {
  await c.query(
    `update split_shares s set state = $3
       from check_splits k
      where k.venue_id = s.venue_id and k.id = s.split_id and k.venue_id = $1 and k.check_id = $2
        and k.ended_at is null and s.state = 'paying'`,
    [venueId, checkId, outcome],
  );
}

/** Whether the check has an open split (a Close that's canceled leaves its check finalized, not reopened). */
export async function hasOpenSplit(c: Queryable, venueId: string, checkId: string) {
  return (await openSplit(c, venueId, checkId)) !== null;
}
