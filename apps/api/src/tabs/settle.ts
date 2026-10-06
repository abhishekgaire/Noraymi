import {
  allocate,
  amountDue,
  insertPayment,
  latestAttempt,
  postingDate,
  type Queryable,
} from "@west4/db";
import type { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { tabHoldOf } from "../payments/splits.js";
import { openAttempt } from "../payments/state.js";
import { goAhead } from "../payments/card-on-file.js";
import { tabSavedCard } from "./saved-card.js";

/**
 * Settling a tab whose capture failed (M6-17; Payment flows · Bar tab with a growing hold, step 7; Data
 * model · Tabs at the cut-off and at close; Money rules 16): a manager collects what it still owes by
 * another card (a new tap), cash, or the card saved from the first tap. Once that money lands, the tab
 * moves `capture_failed` → `closed` (tabs/pay.ts · takeOverHold, which also cancels a hold still standing).
 * The money posts to the business date it's collected on; collected after the tab's own night, it carries
 * `adjusts_business_date` pointing at that night. Until it's settled the tab stays on the manager's list,
 * with its balance, and never holds up the night's close.
 */
export interface SettleStart {
  readonly tabId: string;
  readonly checkId: string;
  /** A hold still standing on the tab: left out of what's due, canceled once the tab is paid. */
  readonly holdId: string | null;
  readonly balanceCents: number;
  /** The posting date (M7-02): where the money posts. */
  readonly today: string;
}

/** Inside the caller's transaction: the tab is capture_failed, nothing is under way, the amount is its balance. */
export async function startSettle(
  c: Queryable,
  venueId: string,
  tabId: string,
  input: { userId: string; amountCents: number; now: Temporal.Instant },
): Promise<SettleStart> {
  const tab = (
    await c.query<{ state: string; check_id: string }>(
      "select state, check_id from tabs where venue_id = $1 and id = $2 for update",
      [venueId, tabId],
    )
  ).rows[0];
  if (!tab) throw new ApiError("not_found", "no such tab");
  if (tab.state !== "capture_failed")
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
  const busy = await c.query(
    `select 1 from payment_allocations where venue_id = $1 and check_id = $2 and state = 'in_progress'
        and payment_id is distinct from $3`,
    [venueId, tab.check_id, hold?.paymentId ?? null],
  );
  if (busy.rowCount)
    throw new ApiError("in_progress", "a payment is already under way on this tab", {
      details: { reason: "payment_in_progress" },
    });
  const balance = await amountDue(c, tab.check_id, hold?.paymentId ?? null);
  if (balance <= 0)
    throw new ApiError("invalid_request", "nothing is due on this tab", {
      details: { reason: "nothing_due" },
    });
  if (input.amountCents !== balance)
    throw new ApiError("invalid_request", "the tab's balance changed", {
      details: { reason: "amount_changed", amount_cents: balance },
    });
  // Who settles it closes it (takeOverHold keeps this for a capture_failed tab).
  await c.query("update tabs set closed_by = $3 where venue_id = $1 and id = $2", [
    venueId,
    tabId,
    input.userId,
  ]);
  return {
    tabId,
    checkId: tab.check_id,
    holdId: hold?.paymentId ?? null,
    balanceCents: balance,
    // The posting date (M7-02): tonight, or the next open night once tonight has closed.
    today: await postingDate(c, venueId, input.now),
  };
}

/**
 * Money collected after the tab's night posts to today, pointing back at that night (Money rules 16). Inside
 * the transaction that wrote the payment.
 */
export async function postLate(
  c: Queryable,
  venueId: string,
  paymentId: string,
  checkId: string,
): Promise<void> {
  await c.query(
    `update payments p set adjusts_business_date = k.business_date
       from checks k
      where p.venue_id = $1 and p.id = $2 and k.venue_id = p.venue_id and k.id = $3
        and p.business_date > k.business_date`,
    [venueId, paymentId, checkId],
  );
}

/**
 * The saved card, charged off-session for what the tab owes. The guest agreed to the tab being charged
 * when it closes (the consent line); the manager settling it is the go-ahead. Answers the attempt to run.
 */
export async function settleToSavedCard(
  c: Queryable,
  venueId: string,
  started: SettleStart,
  now: Temporal.Instant,
): Promise<{ paymentId: string; attemptNo: number }> {
  const saved = await tabSavedCard(c, venueId, started.checkId);
  if (!saved)
    throw new ApiError("invalid_request", "this tab has no saved card", {
      details: { reason: "no_saved_card" },
    });
  const paymentId = await insertPayment(c, venueId, {
    method: "card_on_file",
    status: "pending",
    businessDate: started.today,
  });
  await allocate(c, venueId, {
    paymentId,
    checkId: started.checkId,
    amountCents: started.balanceCents,
    state: "in_progress",
    leaveOut: started.holdId,
  });
  await postLate(c, venueId, paymentId, started.checkId);
  const attemptNo = await goAhead(
    c,
    venueId,
    { paymentId, checkId: started.checkId, amountCents: started.balanceCents },
    now,
  );
  return { paymentId, attemptNo };
}

/** The manager's list (screens Night note 12): every capture_failed tab, whatever its night, with what it owes. */
export async function failedTabs(c: Queryable, venueId: string) {
  const r = await c.query<{
    id: string;
    name: string;
    check_id: string;
    card_brand: string | null;
    card_last4: string | null;
    business_date: string;
  }>(
    `select t.id, t.name, t.check_id, t.card_brand, t.card_last4, k.business_date::text as business_date
       from tabs t join checks k on k.venue_id = t.venue_id and k.id = t.check_id
      where t.venue_id = $1 and t.state = 'capture_failed'
      order by k.business_date, t.opened_at, t.id`,
    [venueId],
  );
  const out = [];
  for (const t of r.rows) {
    const hold = await tabHoldOf(c, venueId, t.check_id);
    const owed = Number(
      (
        await c.query<{ due: string }>("select amount_due($1, $2) as due", [
          t.check_id,
          hold?.paymentId ?? null,
        ])
      ).rows[0]!.due,
    );
    out.push({
      id: t.id,
      name: t.name,
      check_id: t.check_id,
      card: t.card_last4 ? { brand: t.card_brand ?? "", last4: t.card_last4 } : null,
      business_date: t.business_date,
      owed_cents: owed,
      saved_card: (await tabSavedCard(c, venueId, t.check_id)) !== null,
    });
  }
  return out;
}
