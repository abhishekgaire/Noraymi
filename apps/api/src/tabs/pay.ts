import {
  amountDue,
  emitEvent,
  enqueue,
  latestAttempt,
  openSplit,
  setAllocationState,
  type Queryable,
} from "@west4/db";
import type { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { tabHoldOf } from "../payments/splits.js";
import { openAttempt } from "../payments/state.js";
import { finalizeCheck } from "../rooms/finalize.js";
import { reopenCheck } from "../rooms/present.js";
import { moveTab } from "./state.js";

/**
 * Paying a tab another way (M6-11; Payment flows · Paying with a different card, Bar tab step 7; Money
 * rules 12): another card (a new PaymentIntent for the tab's balance, the tip on the reader) or cash.
 * The hold is never canceled first: only once the replacing payment has succeeded does it take over the
 * hold's allocation, in the same transaction that records the success, and the tab closes as `closed`.
 * The hold's cancel (`POST /v1/payment_intents/{id}/cancel`) is a job written in that transaction, run
 * outside it; the reconciler cancels any hold still standing on a closed tab. A declined new card leaves
 * the hold guaranteeing the tab.
 */
export const TAB_CANCEL_HOLD_KIND = "tab.cancel_hold";

export interface TabPaymentStart {
  readonly tabId: string;
  readonly checkId: string;
  /** The hold this payment replaces, left out of what's due; none on a tab without a standing hold. */
  readonly holdId: string | null;
  readonly balanceCents: number;
}

/**
 * Before another card or cash (inside the caller's transaction): the tab is open, nothing else is being
 * paid on it, and it isn't split (a split's shares pay one by one). The check is finalized, so nothing
 * more goes on the tab while it's paid, and its balance (its hold left out) is what the payment takes.
 */
export async function startTabPayment(
  c: Queryable,
  venueId: string,
  tabId: string,
  input: { userId: string; amountCents: number; now: Temporal.Instant },
): Promise<TabPaymentStart> {
  const r = await c.query<{ state: string; check_id: string }>(
    "select state, check_id from tabs where venue_id = $1 and id = $2 for update",
    [venueId, tabId],
  );
  const tab = r.rows[0];
  if (!tab) throw new ApiError("not_found", "no such tab");
  if (tab.state !== "open")
    throw new ApiError("invalid_request", `this tab is ${tab.state}`, {
      details: { reason: "tab_state", state: tab.state },
    });
  const hold = await tabHoldOf(c, venueId, tab.check_id);
  if (hold) {
    const last = await latestAttempt(c, venueId, hold.paymentId);
    if (last && openAttempt(last.state))
      throw new ApiError("payment_unknown", "Checking with Stripe · don't retry", {
        details: { reason: "hold_checking", payment_id: hold.paymentId },
      });
  }
  if (await openSplit(c, venueId, tab.check_id))
    throw new ApiError("invalid_request", "this tab is split: pay it share by share", {
      details: { reason: "split_open" },
    });
  const busy = await c.query(
    `select 1 from payment_allocations where venue_id = $1 and check_id = $2 and state = 'in_progress'
        and payment_id is distinct from $3`,
    [venueId, tab.check_id, hold?.paymentId ?? null],
  );
  if (busy.rowCount)
    throw new ApiError("in_progress", "a payment is already under way on this tab", {
      details: { reason: "payment_in_progress" },
    });
  await finalizeCheck(c, venueId, tab.check_id, { userId: input.userId, now: input.now });
  await c.query("update checks set status = 'finalized' where venue_id = $1 and id = $2", [
    venueId,
    tab.check_id,
  ]);
  const balance = await amountDue(c, tab.check_id, hold?.paymentId ?? null);
  if (balance <= 0)
    throw new ApiError("invalid_request", "nothing is due on this tab", {
      details: { reason: "nothing_due" },
    });
  if (input.amountCents !== balance)
    throw new ApiError("invalid_request", "the tab's balance changed", {
      details: { reason: "amount_changed", amount_cents: balance },
    });
  return { tabId, checkId: tab.check_id, holdId: hold?.paymentId ?? null, balanceCents: balance };
}

/**
 * After money lands on a tab's check (inside the transaction that records it): once the tab owes nothing
 * beside its hold and nothing else is in flight, the payment takes over the hold's allocation, the hold's
 * cancel is written as a job, and the tab closes (`closed`). A tab paid only in part keeps its hold.
 * Answers the hold to cancel, if there is one.
 */
export async function takeOverHold(
  c: Queryable,
  venueId: string,
  checkId: string,
  now: Temporal.Instant,
): Promise<{ tabId: string; holdId: string | null } | null> {
  const r = await c.query<{ id: string; state: string }>(
    "select id, state from tabs where venue_id = $1 and check_id = $2 for update",
    [venueId, checkId],
  );
  const tab = r.rows[0];
  if (!tab || tab.state !== "open") return null;
  const hold = await tabHoldOf(c, venueId, checkId);
  const inFlight = await c.query(
    `select 1 from payment_allocations where venue_id = $1 and check_id = $2 and state = 'in_progress'
        and payment_id is distinct from $3`,
    [venueId, checkId, hold?.paymentId ?? null],
  );
  if (inFlight.rowCount) return null;
  // Every cent is paid by something other than the hold (the replacement, and any paid shares).
  const paid = await c.query(
    `select 1 from payment_allocations where venue_id = $1 and check_id = $2 and state = 'captured'
        and payment_id is distinct from $3`,
    [venueId, checkId, hold?.paymentId ?? null],
  );
  if (!paid.rowCount || (await amountDue(c, checkId, hold?.paymentId ?? null)) > 0) return null;
  if (hold) {
    await setAllocationState(c, venueId, hold.paymentId, "in_progress", "released");
    await enqueue(c, {
      venueId,
      kind: TAB_CANCEL_HOLD_KIND,
      pool: "critical",
      dedupeKey: `${TAB_CANCEL_HOLD_KIND}:${hold.paymentId}`,
      payload: { payment_id: hold.paymentId },
      runAt: now,
      maxAttempts: 5,
    });
  }
  // The hold that was declined a raise is gone with it (M6-07's "Hold raise declined").
  await c.query("update tabs set hold_declined_at = null where venue_id = $1 and id = $2", [
    venueId,
    tab.id,
  ]);
  await moveTab(c, venueId, tab.id, "closed");
  // Closed by whoever finalized it to be paid (the person who took the cash or started the tap).
  await c.query(
    `update tabs t set closed_at = $3, closed_by = (select r.finalized_by from check_revisions r
        where r.venue_id = t.venue_id and r.check_id = t.check_id order by r.rev desc limit 1)
      where t.venue_id = $1 and t.id = $2`,
    [venueId, tab.id, now.toString()],
  );
  await emitEvent(c, { venueId, type: "tab.updated", entityId: tab.id });
  return { tabId: tab.id, holdId: hold?.paymentId ?? null };
}

/**
 * A tab's payment that ended without money (canceled, or failed): an open tab that isn't split, with
 * nothing else in flight, takes drinks again (its check reopened), and its hold still guarantees it.
 */
export async function afterTabPaymentEnded(c: Queryable, venueId: string, checkId: string) {
  const r = await c.query<{ id: string; status: string; reopened: boolean }>(
    `select t.id, k.status, t.reopened_at is not null as reopened from tabs t join checks k on k.venue_id = t.venue_id and k.id = t.check_id
      where t.venue_id = $1 and t.check_id = $2 and t.state = 'open'`,
    [venueId, checkId],
  );
  const tab = r.rows[0];
  if (!tab || tab.status !== "finalized") return;
  if (await openSplit(c, venueId, checkId)) return;
  const hold = await tabHoldOf(c, venueId, checkId);
  const inFlight = await c.query(
    `select 1 from payment_allocations where venue_id = $1 and check_id = $2 and state in ('in_progress', 'captured')
        and (state = 'in_progress' or not $4) and payment_id is distinct from $3`,
    // A reopened tab (M6-12) keeps what was paid before as paid: only a payment under way holds it.
    [venueId, checkId, hold?.paymentId ?? null, tab.reopened],
  );
  if (inFlight.rowCount) return;
  await reopenCheck(c, venueId, checkId);
  await emitEvent(c, { venueId, type: "tab.updated", entityId: tab.id });
}

/** Holds on closed tabs that nothing guarantees any more: the reconciler cancels any still standing. */
export async function holdsToCancel(c: Queryable, venueId: string): Promise<string[]> {
  const r = await c.query<{ id: string }>(
    `select p.id from tabs t join payments p on p.venue_id = t.venue_id and p.id = t.payment_id
      where t.venue_id = $1 and t.state = 'closed' and p.status = 'authorized'
        and not exists (select 1 from payment_allocations a where a.venue_id = p.venue_id
                          and a.payment_id = p.id and a.state = 'in_progress')`,
    [venueId],
  );
  return r.rows.map((x) => x.id);
}

/** A replacing card still pending on the tab whose tap was declined: set aside before paying another way. */
export async function declinedOnTab(
  c: Queryable,
  venueId: string,
  tabId: string,
): Promise<string[]> {
  const r = await c.query<{ id: string; state: string | null }>(
    `select p.id, (select a2.state from payment_attempts a2 where a2.venue_id = p.venue_id and a2.payment_id = p.id
                    order by a2.attempt_no desc limit 1) as state
       from tabs t
       join payment_allocations a on a.venue_id = t.venue_id and a.check_id = t.check_id and a.state = 'in_progress'
       join payments p on p.venue_id = a.venue_id and p.id = a.payment_id
      where t.venue_id = $1 and t.id = $2 and a.share_id is null and p.status = 'pending'
        and p.method = 'card_present' and p.id is distinct from t.payment_id`,
    [venueId, tabId],
  );
  return r.rows.filter((x) => x.state === "failed" || x.state === "canceled").map((x) => x.id);
}
