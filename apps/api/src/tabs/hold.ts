import {
  AttemptOpen,
  clearDraft,
  emitEvent,
  latestAttempt,
  readSetting,
  recordAuthorization,
  setAttemptState,
  startAttempt,
  type OrderRow,
  type Queryable,
} from "@west4/db";
import {
  businessDate,
  canGrow,
  holdDecision,
  holdLeftCents,
  holdNeededCents,
  type HoldCard,
} from "@west4/rules";
import { cents, formatMoney, type Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { TargetGone, executors, managerOnDutyAt, requestApproval } from "../approvals/service.js";
import type { PendingAnswer } from "../approvals/service.js";
import { placeStaffOrder, type GiftFor, type StaffLine } from "../orders/place.js";
import { enqueuePush } from "../push/send-push.js";
import { venueClock } from "../rooms/assignment.js";
import { checkView } from "../rooms/checks.js";
import type { IntentObservation } from "../stripe/payments.js";
import { openAttempt } from "../payments/state.js";
import { enqueueRun } from "../payments/run.js";
import { approvedLineMove } from "./move.js";

/**
 * A bar tab's growing hold (M6-07; Payment flows · Bar tab with a growing
 * hold, steps 2 to 4; Money rules 12; Stripe setup 5):
 *  - a send onto a tab with a hold is placed inside a savepoint first, to see
 *    what the tab would need held afterwards: its balance plus a 25% tip
 *    reserve on its drinks (packages/rules · holdDecision);
 *  - when that passes the hold and the card can grow, the round is rolled
 *    back and an `increment` attempt is written, keyed
 *    `<payment_id>:increment:<attempt_no>:<target>`; the payment run calls
 *    `increment_authorization` outside any transaction, and the send is tried
 *    again once Stripe has answered;
 *  - a declined raise keeps the old hold and marks the tab "Hold raise
 *    declined": every round on it then waits for a manager (`over_hold`);
 *  - a card that can't grow (or has used 8 of Stripe's 10 attempts) is capped
 *    at the hold plus the overcapture allowance, minus the tip reserve;
 *  - an unclear raise is an unknown attempt ("Checking with Stripe · don't
 *    retry"): the round waits unsent until the poller or the reconciler knows.
 * A tab passing `tabs.flagOverCents` is pushed once to the manager on duty.
 */
export interface TabHold {
  readonly tab_id: string;
  readonly check_id: string;
  readonly name: string;
  readonly state: string;
  readonly hold_cents: number;
  readonly payment_id: string | null;
  readonly payment_status: string | null;
  readonly incremental_supported: boolean | null;
  readonly overcapture_supported: boolean | null;
  readonly increments_used: number;
  readonly hold_declined_at: string | null;
  readonly flagged_over_at: string | null;
}

export const TAB_HOLD_COLS = `t.id as tab_id, t.check_id, t.name, t.state, t.hold_cents, t.payment_id,
  p.status as payment_status, p.incremental_supported, p.overcapture_supported,
  coalesce(p.increments_used, 0)::int as increments_used,
  to_json(t.hold_declined_at) #>> '{}' as hold_declined_at,
  to_json(t.flagged_over_at) #>> '{}' as flagged_over_at`;

export async function tabOfCheck(
  c: Queryable,
  venueId: string,
  checkId: string,
  lock = false,
): Promise<TabHold | null> {
  const r = await c.query<TabHold>(
    `select ${TAB_HOLD_COLS}
       from tabs t left join payments p on p.venue_id = t.venue_id and p.id = t.payment_id
      where t.venue_id = $1 and t.check_id = $2${lock ? " for update of t" : ""}`,
    [venueId, checkId],
  );
  return r.rows[0] ?? null;
}

/** The hold as the rules see it, while it's placed and not yet captured. */
export const holdCardOf = (t: TabHold): HoldCard | null =>
  t.payment_id && t.payment_status === "authorized"
    ? {
        holdCents: t.hold_cents,
        incrementalSupported: t.incremental_supported === true,
        overcaptureSupported: t.overcapture_supported === true,
        incrementsUsed: t.increments_used,
      }
    : null;

/**
 * What the tab owes and needs held: its balance leaves its own hold out (Money rules 12), so it's the
 * total less what every other payment has captured or has in progress; plus the tip reserve.
 */
export async function tabNeed(
  c: Queryable,
  venueId: string,
  tab: Pick<TabHold, "check_id" | "payment_id">,
  now: Temporal.Instant,
) {
  const view = await checkView(c, venueId, tab.check_id, now);
  const total = view.totals?.total_cents ?? 0;
  const drinks = view.totals?.subtotal_cents ?? 0;
  const paid = (
    await c.query<{ s: number }>(
      `select coalesce(sum(amount_cents), 0)::int as s from payment_allocations
        where venue_id = $1 and check_id = $2 and state in ('captured', 'in_progress')
          and payment_id is distinct from $3`,
      [venueId, tab.check_id, tab.payment_id],
    )
  ).rows[0]!.s;
  const balance = total - paid;
  return {
    totalCents: total,
    drinksCents: drinks,
    balanceCents: balance,
    needCents: holdNeededCents(balance, drinks),
  };
}

/** What the bar screen shows about a tab's hold: its headroom, capped or growing, and a declined raise. */
export async function holdView(c: Queryable, venueId: string, t: TabHold, now: Temporal.Instant) {
  const card = holdCardOf(t);
  if (!card) return null;
  const need = await tabNeed(c, venueId, t, now);
  const attempt = t.payment_id ? await latestAttempt(c, venueId, t.payment_id) : null;
  return {
    cents: t.hold_cents,
    left_cents: holdLeftCents(card, need.needCents),
    can_grow: canGrow(card),
    declined: t.hold_declined_at !== null,
    checking: attempt?.action === "increment" && openAttempt(attempt.state),
    increments_used: t.increments_used,
  };
}

export type SendAnswer =
  | { readonly kind: "placed"; readonly order: OrderRow }
  | { readonly kind: "approval"; readonly pending: PendingAnswer }
  | { readonly kind: "raise"; readonly paymentId: string; readonly attemptNo: number }
  | { readonly kind: "checking"; readonly paymentId: string };

export interface SendInput {
  readonly checkId: string;
  readonly lines: readonly StaffLine[];
  readonly clientOrderId: string | null;
  readonly userId: string;
  readonly membershipId: string;
  readonly deviceId: string | null;
  readonly now: Temporal.Instant;
  /** After one raise, a second one isn't asked for in the same send. */
  readonly raised?: boolean;
  /** A gift order for a singer (M6-24): charged here, checked against the singer's check. */
  readonly gift?: GiftFor | null;
}

/**
 * A round sent onto a check (M3-07's staff order), with the hold checked first when the check is an open
 * tab with a placed hold. Runs inside the caller's transaction; a raise is written here and run by the
 * caller outside it.
 */
export async function sendRound(
  c: Queryable,
  venueId: string,
  input: SendInput,
): Promise<SendAnswer> {
  const tab = await tabOfCheck(c, venueId, input.checkId, true);
  const card = tab && tab.state === "open" ? holdCardOf(tab) : null;
  if (!tab || !card) {
    const order = await placeStaffOrder(c, venueId, input);
    if (tab) await flagIfOver(c, venueId, tab, input.now);
    return { kind: "placed", order };
  }
  if (input.clientOrderId) {
    // A retried send answers what it did the first time: the order, or the round waiting for a manager.
    const seen = await c.query<{ id: string }>(
      "select id from orders where venue_id = $1 and client_order_id = $2",
      [venueId, input.clientOrderId],
    );
    if (seen.rows[0]) return { kind: "placed", order: await placeStaffOrder(c, venueId, input) };
    const asked = await c.query<{ id: string; routed_to: string; name: string }>(
      `select a.id, a.routed_to, u.name from approvals a join users u on u.id = a.routed_to
        where a.venue_id = $1 and a.kind = 'over_hold' and a.payload->>'client_order_id' = $2`,
      [venueId, input.clientOrderId],
    );
    const a = asked.rows[0];
    if (a)
      return {
        kind: "approval",
        pending: {
          status: "approval_pending",
          approval_id: a.id,
          waiting_for: { user_id: a.routed_to, name: a.name },
        },
      };
  }
  const step = await withinHold(c, venueId, tab, card, input, () =>
    placeStaffOrder(c, venueId, { ...input, keepDraft: true }),
  );
  if (step.kind === "raise" || step.kind === "checking") return step;
  const order = step.value;
  if (step.kind === "declined") {
    // Hold raise declined: the round waits for a manager's OK, and leaves the draft with the request.
    const pending = await requestApproval(c, venueId, {
      kind: "over_hold",
      targetKind: "tab",
      targetId: tab.tab_id,
      amountCents: order.amount_cents,
      reason: "Hold raise declined",
      payload: {
        check_id: tab.check_id,
        client_order_id: input.clientOrderId,
        lines: input.lines,
        membership_id: input.membershipId,
        device_id: input.deviceId,
        ...(input.gift ? { gift: input.gift } : {}),
        description: `${tab.name} · ${order.items
          .map((i) => (i.qty > 1 ? `${i.qty} × ${i.name_snapshot}` : i.name_snapshot))
          .join(", ")}`,
      },
      requestedBy: input.userId,
      requestedDeviceId: input.deviceId,
      now: input.now,
    });
    const version = await clearDraft(
      c,
      venueId,
      input.membershipId,
      input.checkId,
      input.now.toString(),
    );
    if (version !== null)
      await emitEvent(c, {
        venueId,
        type: "draft.updated",
        entityId: input.checkId,
        entityVersion: version,
        audience: "user",
        userId: input.userId,
      });
    await emitEvent(c, { venueId, type: "tab.updated", entityId: tab.tab_id });
    return { kind: "approval", pending };
  }
  // The round is placed: the draft empties as any send does.
  await clearSent(c, venueId, input);
  await flagIfOver(c, venueId, tab, input.now);
  return { kind: "placed", order };
}

export type HoldStep<T> =
  | { readonly kind: "fits"; readonly value: T }
  | { readonly kind: "declined"; readonly value: T }
  | { readonly kind: "raise"; readonly paymentId: string; readonly attemptNo: number }
  | { readonly kind: "checking"; readonly paymentId: string };

/**
 * The hold check every change that adds to a tab runs (a round sent, M6-07; a line moved onto it, M6-13;
 * Money rules 12): the change is made inside a savepoint to see what the tab would need held afterwards.
 *  - it fits: it stays (`fits`);
 *  - the tab's raise was declined: it's rolled back (`declined`, with what it would have been), for the
 *    caller to send to a manager;
 *  - the card can grow: it's rolled back and an `increment` attempt is written (`raise`), run by the
 *    caller outside the transaction before trying again with `raised`;
 *  - a raise is still being checked with Stripe: nothing is tried (`checking`);
 *  - the card can't grow: `hold_cap`; a second raise in one go: `hold_not_raised`.
 */
export async function withinHold<T>(
  c: Queryable,
  venueId: string,
  tab: TabHold,
  card: HoldCard,
  input: { readonly now: Temporal.Instant; readonly raised?: boolean },
  apply: () => Promise<T>,
): Promise<HoldStep<T>> {
  // A raise still being checked with Stripe: nothing more is added until it's known.
  const last = await latestAttempt(c, venueId, tab.payment_id!);
  if (last?.action === "increment" && openAttempt(last.state))
    return { kind: "checking", paymentId: tab.payment_id! };

  await c.query("savepoint hold_check");
  const value = await apply();
  if (tab.hold_declined_at) {
    await c.query("rollback to savepoint hold_check");
    return { kind: "declined", value };
  }
  const need = await tabNeed(c, venueId, tab, input.now);
  const decision = holdDecision(card, need.needCents);
  if (decision.kind === "fits") {
    await c.query("release savepoint hold_check");
    return { kind: "fits", value };
  }
  await c.query("rollback to savepoint hold_check");
  if (decision.kind === "capped")
    throw new ApiError(
      "invalid_request",
      "this card's hold can't grow, and the round doesn't fit",
      {
        details: {
          reason: "hold_cap",
          left_cents: holdLeftCents(card, (await tabNeed(c, venueId, tab, input.now)).needCents),
        },
      },
    );
  if (input.raised)
    throw new ApiError("stripe_error", "the hold didn't grow: try again, or pay another way", {
      details: { reason: "hold_not_raised" },
    });
  try {
    const { attemptNo } = await startAttempt(c, venueId, {
      paymentId: tab.payment_id!,
      checkId: tab.check_id,
      portionKey: "tab",
      action: "increment",
      amountCents: decision.targetCents,
      keySuffix: String(decision.targetCents),
      startedAt: input.now.toString(),
    });
    // Every attempt counts against Stripe's 10, declines and unclear ones included.
    await c.query(
      "update payments set increments_used = increments_used + 1 where venue_id = $1 and id = $2",
      [venueId, tab.payment_id],
    );
    await enqueueRun(c, venueId, tab.payment_id!, attemptNo, input.now);
    return { kind: "raise", paymentId: tab.payment_id!, attemptNo };
  } catch (e) {
    if (e instanceof AttemptOpen) return { kind: "checking", paymentId: tab.payment_id! };
    throw e;
  }
}

/** The person's draft for the tab empties once its round is placed (as placeStaffOrder does). */
async function clearSent(c: Queryable, venueId: string, input: SendInput) {
  const version = await clearDraft(
    c,
    venueId,
    input.membershipId,
    input.checkId,
    input.now.toString(),
  );
  if (version !== null)
    await emitEvent(c, {
      venueId,
      type: "draft.updated",
      entityId: input.checkId,
      entityVersion: version,
      audience: "user",
      userId: input.userId,
    });
}

/**
 * Inside the state machine's transaction: what Stripe said about a raise. A hold that reached the
 * target grows the tab's hold; a declined raise marks the tab. Answers whether anything changed.
 */
export async function settleIncrement(
  c: Queryable,
  venueId: string,
  paymentId: string,
  intent: IntentObservation | null,
  now: Temporal.Instant,
): Promise<boolean> {
  const attempt = await latestAttempt(c, venueId, paymentId);
  if (attempt?.action !== "increment") return false;
  const tab = (
    await c.query<{ id: string; hold_declined_at: string | null }>(
      "select id, hold_declined_at from tabs where venue_id = $1 and payment_id = $2 for update",
      [venueId, paymentId],
    )
  ).rows[0];
  if (openAttempt(attempt.state) && intent && intent.amountCapturable >= attempt.amount_cents) {
    await setAttemptState(c, venueId, paymentId, attempt.attempt_no, "succeeded");
    await recordAuthorization(c, paymentId, intent.amountCapturable);
    if (tab) {
      await c.query("update tabs set hold_cents = $3 where venue_id = $1 and id = $2", [
        venueId,
        tab.id,
        intent.amountCapturable,
      ]);
      await emitEvent(c, { venueId, type: "tab.updated", entityId: tab.id });
    }
    return true;
  }
  if (
    tab &&
    attempt.state === "failed" &&
    attempt.decline_code === "card_declined" &&
    !tab.hold_declined_at
  ) {
    await c.query("update tabs set hold_declined_at = $3 where venue_id = $1 and id = $2", [
      venueId,
      tab.id,
      now.toString(),
    ]);
    await emitEvent(c, { venueId, type: "tab.updated", entityId: tab.id });
    return true;
  }
  return false;
}

/** A tab passing `tabs.flagOverCents` ($600 at West 4) shows once on the manager on duty's phone. */
export async function flagIfOver(
  c: Queryable,
  venueId: string,
  tab: Pick<TabHold, "tab_id" | "check_id" | "payment_id" | "name" | "flagged_over_at">,
  now: Temporal.Instant,
) {
  if (tab.flagged_over_at) return;
  const venue = await venueClock(c, venueId);
  const date = businessDate(now, venue.timeZone, venue.dayCutover).businessDate;
  const limit = (await readSetting(c, venueId, "tabs", date))?.value.flagOverCents;
  if (!limit) return;
  const { totalCents } = await tabNeed(c, venueId, tab, now);
  if (totalCents <= limit) return;
  await c.query("update tabs set flagged_over_at = $3 where venue_id = $1 and id = $2", [
    venueId,
    tab.tab_id,
    now.toString(),
  ]);
  await emitEvent(c, { venueId, type: "tab.updated", entityId: tab.tab_id });
  const manager = await managerOnDutyAt(c, venueId, now);
  if (!manager) return;
  await enqueuePush(c, {
    venueId,
    audience: { kind: "person", userId: manager },
    message: {
      key: "tabs.push.over",
      params: {
        name: tab.name,
        limit: formatMoney("en", cents(limit)),
        total: formatMoney("en", cents(totalCents)),
      },
      url: "/tonight",
      tag: `tab-over-${tab.tab_id}`,
    },
    runAt: now,
    dedupeKey: `tab-over:${tab.tab_id}`,
  });
}

/**
 * A manager OKs a round on a tab whose hold raise was declined (approvals kind over_hold): it's placed
 * as the person who rang it, with the alcohol checks run again now. A tab that closed, or a round the
 * night no longer allows, expires the request instead.
 */
executors.set("over_hold", async (c, venueId, approval, ctx) => {
  const p = approval.payload as {
    check_id: string;
    client_order_id: string | null;
    lines: StaffLine[];
    membership_id: string;
    device_id: string | null;
    gift?: GiftFor;
  };
  const tab = await tabOfCheck(c, venueId, p.check_id, true);
  if (!tab || tab.state !== "open") throw new TargetGone();
  // A line moved onto the tab (M6-13): checked again, then moved as the person who asked.
  const move = (approval.payload as { move?: Parameters<typeof approvedLineMove>[2] }).move;
  if (move) {
    try {
      await approvedLineMove(c, venueId, move, {
        requestedBy: approval.requested_by,
        approvedBy: ctx.approverId,
        at: ctx.at,
      });
    } catch (e) {
      if (e instanceof ApiError) throw new TargetGone();
      throw e;
    }
    await flagIfOver(c, venueId, tab, ctx.at);
    return;
  }
  try {
    await placeStaffOrder(c, venueId, {
      checkId: p.check_id,
      lines: p.lines,
      clientOrderId: p.client_order_id,
      userId: approval.requested_by,
      membershipId: p.membership_id,
      deviceId: p.device_id,
      now: ctx.at,
      keepDraft: true,
      gift: p.gift ?? null,
    });
  } catch (e) {
    if (e instanceof ApiError) throw new TargetGone();
    throw e;
  }
  await emitEvent(c, { venueId, type: "tab.updated", entityId: tab.tab_id });
  await flagIfOver(c, venueId, tab, ctx.at);
});
