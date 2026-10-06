import {
  allocate,
  emitEvent,
  enqueue,
  latestAttempt,
  paymentById,
  readSetting,
  readerOfVenue,
  setAllocationState,
  setTip,
  startAttempt,
  stripeAccountOf,
  withVenue,
  type AttemptRow,
  type PaymentRow,
  type Queryable,
} from "@west4/db";
import { businessDate, closePlan, tipChoices } from "@west4/rules";
import { cents, formatMoney, type Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { finalizeCheck } from "../rooms/finalize.js";
import { reopenCheck } from "../rooms/present.js";
import { venueClock } from "../rooms/assignment.js";
import { checkView } from "../rooms/checks.js";
import { surchargeFor } from "../payments/surcharge.js";
import { openAttempt } from "../payments/state.js";
import { screenState } from "../payments/machine.js";
import { StripeError, StripeUnknownResult } from "../stripe/client.js";
import { collectInputs, inputsAnswerOf, type ReaderInput } from "../stripe/tabs.js";
import { cancelReaderAction } from "../stripe/payments.js";
import { retrieveReader } from "../stripe/terminal.js";
import { sendReceipt, type ReceiptDeps } from "../receipts/send.js";
import { TAB_HOLD_COLS, holdCardOf, tabNeed, type TabHold } from "./hold.js";
import { moveTab } from "./state.js";
import { printSlip } from "./slip.js";
import { enqueueRun, runNow, type PaymentDeps } from "../payments/run.js";

/**
 * Closing a bar tab on its hold, with the tip on the reader (M6-08; Payment
 * flows · Bar tab with a growing hold, step 5; Stripe setup 4; Money rules 9
 * and 10):
 *  - Close finalizes the tab's check (items plus tax, plus a gratuity only
 *    where the venue adds one to bar tabs) and moves the tab to `tipping`;
 *  - the bar reader asks for the tip through `collect_inputs`: the venue's
 *    three choices of the drinks before tax, each with its amount ($1, $2 and
 *    $3 under $10), then Custom (a number) and No tip. A gratuity on the tab,
 *    or No tip from the screen, skips the question;
 *  - the total plus the tip is captured in one call (`amount_to_capture`,
 *    keyed `<payment_id>:capture:<attempt_no>:<amount>`), the tip recorded
 *    with set_tip(). Above the hold plus Stripe's overcapture allowance the
 *    hold is raised first; a hold that can't cover it leaves the tab
 *    `capture_failed` for a manager;
 *  - Cancel on the reader (or on the screen) puts the tab back to `open`; a
 *    tip screen left untouched for 2 minutes is taken down and the paper slip
 *    prints, the tab `awaiting_tip` with its hold standing (M6-09);
 *  - the paper slip (a reader that's offline, a guest who asks, or a venue
 *    whose bar tabs tip on paper, `pos.barTabTip`) leaves the Close in state
 *    `slip` until the tip is typed in from Tips to enter (tabs/tip.ts);
 *  - what the guest picked (the choice, its amount, when and on which reader)
 *    stays in `tab_closings` with the payment, as dispute evidence.
 * Every reader and Stripe call is outside a transaction, with its own key.
 */
export const TAB_CLOSE_CHECK_KIND = "tab.close_check";
export const TIP_SCREEN_S = 120;
const POLL_S = 2;

export type ClosingState =
  | "asking"
  | "custom"
  | "raising"
  | "capturing"
  | "captured"
  | "canceled"
  | "timed_out"
  | "failed"
  | "slip";
const ACTIVE: readonly ClosingState[] = ["asking", "custom", "raising", "capturing"];

export interface ClosingRow {
  id: string;
  tab_id: string;
  check_id: string;
  payment_id: string;
  path: "reader" | "none" | "slip";
  reader_device_id: string | null;
  stripe_reader_id: string | null;
  state: ClosingState;
  step_no: number;
  step_started_at: string | null;
  balance_cents: number;
  drinks_cents: number;
  gratuity_cents: number;
  tip_kind: "percent" | "fixed" | null;
  choices_cents: number[];
  tip_choice: string | null;
  tip_cents: number | null;
  tip_picked_at: string | null;
  capture_cents: number | null;
  receipt: "text" | "print" | "none" | null;
  receipt_step_no: number | null;
  receipt_sent_at: string | null;
  closed_by: string;
  slip_printed_at: string | null;
  slip_photo_file_id: string | null;
  tip_entered_by: string | null;
  tip_entered_at: string | null;
  tip_approval_id: string | null;
}

const CLOSING_COLS = `id, tab_id, check_id, payment_id, path, reader_device_id, stripe_reader_id, state, step_no,
  to_json(step_started_at) #>> '{}' as step_started_at, balance_cents, drinks_cents, gratuity_cents, tip_kind,
  choices_cents, tip_choice, tip_cents, to_json(tip_picked_at) #>> '{}' as tip_picked_at, capture_cents,
  receipt, receipt_step_no, to_json(receipt_sent_at) #>> '{}' as receipt_sent_at, closed_by,
  to_json(slip_printed_at) #>> '{}' as slip_printed_at, slip_photo_file_id, tip_entered_by,
  to_json(tip_entered_at) #>> '{}' as tip_entered_at, tip_approval_id`;

export async function closingById(c: Queryable, venueId: string, id: string, lock = false) {
  const r = await c.query<ClosingRow>(
    `select ${CLOSING_COLS} from tab_closings where venue_id = $1 and id = $2${lock ? " for update" : ""}`,
    [venueId, id],
  );
  return r.rows[0] ?? null;
}

/** The tab's latest Close, if it has one. */
export async function latestClosing(c: Queryable, venueId: string, tabId: string) {
  const r = await c.query<ClosingRow>(
    `select ${CLOSING_COLS} from tab_closings where venue_id = $1 and tab_id = $2
      order by created_at desc, id desc limit 1`,
    [venueId, tabId],
  );
  return r.rows[0] ?? null;
}

async function activeClosingOfPayment(c: Queryable, venueId: string, paymentId: string) {
  const r = await c.query<ClosingRow>(
    `select ${CLOSING_COLS} from tab_closings
      where venue_id = $1 and payment_id = $2 and state = any($3) for update`,
    [venueId, paymentId, ACTIVE],
  );
  return r.rows[0] ?? null;
}

async function tabById(c: Queryable, venueId: string, tabId: string): Promise<TabHold> {
  const r = await c.query<TabHold>(
    `select ${TAB_HOLD_COLS}
       from tabs t left join payments p on p.venue_id = t.venue_id and p.id = t.payment_id
      where t.venue_id = $1 and t.id = $2 for update of t`,
    [venueId, tabId],
  );
  if (!r.rows[0]) throw new ApiError("not_found", "no such tab");
  return r.rows[0];
}

/** The reader's step tag: an answer is matched to the question that asked it. */
const stepTag = (closing: Pick<ClosingRow, "id" | "step_no">) => `${closing.id}:${closing.step_no}`;
const receiptTag = (closing: Pick<ClosingRow, "id" | "receipt_step_no">) =>
  `${closing.id}:receipt:${closing.receipt_step_no ?? 0}`;

/** The choices' ids on the reader, and what each is kept as in the evidence. */
const choiceId = (i: number) => `tip_${i}`;

/** The question the reader shows now. Guest-facing words, in the venue's English (Stripe's screen). */
export async function readerQuestion(
  c: Queryable,
  venueId: string,
  closing: ClosingRow,
  now: Temporal.Instant,
): Promise<ReaderInput> {
  if (closing.state === "custom")
    return { type: "numeric", title: "Custom tip", description: "Whole dollars" };
  const pcts = (await tipScreen(c, venueId, now))?.pcts ?? [];
  const choices = closing.choices_cents.map((amount, i) => ({
    id: choiceId(i),
    text:
      closing.tip_kind === "percent" && pcts[i] !== undefined
        ? `${formatMoney("en", cents(amount))} (${pcts[i]}%)`
        : formatMoney("en", cents(amount)),
  }));
  return {
    type: "selection",
    title: `Add a tip · ${formatMoney("en", cents(closing.balance_cents))}`,
    choices: [...choices, { id: "custom", text: "Custom" }, { id: "none", text: "No tip" }],
  };
}

async function tipScreen(c: Queryable, venueId: string, now: Temporal.Instant) {
  const venue = await venueClock(c, venueId);
  const date = businessDate(now, venue.timeZone, venue.dayCutover).businessDate;
  return (await readSetting(c, venueId, "pay", date))?.value.tipScreen ?? null;
}

export interface StartClose {
  readonly path: "reader" | "slip" | "none";
  readonly readerDeviceId: string | null;
  readonly userId: string;
  readonly now: Temporal.Instant;
  readonly readerQuiet: (
    c: Queryable,
    venueId: string,
    deviceId: string,
    now: Temporal.Instant,
  ) => Promise<boolean>;
}

export type Started =
  | { readonly kind: "asking"; readonly closingId: string }
  | { readonly kind: "run"; readonly closingId: string; readonly paymentId: string }
  | { readonly kind: "slip" };

/**
 * Close (inside the caller's transaction): the check is finalized, the tab moves to `tipping`, and either
 * the reader is to be asked (the caller asks it outside the transaction) or the capture is written.
 */
export async function startClose(
  c: Queryable,
  venueId: string,
  tabId: string,
  input: StartClose,
): Promise<Started> {
  const tab = await tabById(c, venueId, tabId);
  if (tab.state !== "open")
    throw new ApiError("invalid_request", `this tab is ${tab.state}`, {
      details: { reason: "tab_state", state: tab.state },
    });
  const card = holdCardOf(tab);
  // A reopened tab whose hold was captured has no hold, and never offers "Close to card" (step 9).
  if (!card || !tab.payment_id)
    throw new ApiError("invalid_request", "this tab has no hold to close to", {
      details: { reason: "no_hold" },
    });
  const last = await latestAttempt(c, venueId, tab.payment_id);
  if (last && openAttempt(last.state))
    throw new ApiError("payment_unknown", "Checking with Stripe · don't retry", {
      details: { reason: "hold_checking", payment_id: tab.payment_id },
    });
  const payment = (await paymentById(c, venueId, tab.payment_id))!;
  // A venue whose bar tabs tip on paper prints the slip first; the slip is the fallback either way.
  const venue = await venueClock(c, venueId);
  const today = businessDate(input.now, venue.timeZone, venue.dayCutover).businessDate;
  const tipPath = (await readSetting(c, venueId, "pos", today))?.value.barTabTip ?? "reader";
  if (input.path === "reader" && tipPath === "slip") input = { ...input, path: "slip" };
  // With the card fee on, a surcharge can't follow a growing hold: such a venue closes with a fresh tap.
  if (input.path !== "slip" && (await surchargeFor(c, venueId, payment.business_date)) !== null)
    throw new ApiError("invalid_request", "with the card fee on, close with a new tap", {
      details: { reason: "card_fee_fresh_tap" },
    });
  let reader: { id: string; stripe_reader_id: string } | null = null;
  if (input.path === "reader") {
    if (!input.readerDeviceId)
      throw new ApiError("invalid_request", "pick the reader", { details: { reason: "reader" } });
    reader = await readerOfVenue(c, venueId, input.readerDeviceId);
    if (!reader) throw new ApiError("not_found", "no such reader");
    if (await input.readerQuiet(c, venueId, input.readerDeviceId, input.now))
      throw new ApiError("reader_offline", "the bar reader is offline: print the slip instead", {
        details: { reader_id: input.readerDeviceId, slip: true },
      });
  }

  await finalizeCheck(c, venueId, tab.check_id, { userId: input.userId, now: input.now });
  await c.query("update checks set status = 'finalized' where venue_id = $1 and id = $2", [
    venueId,
    tab.check_id,
  ]);
  const view = await checkView(c, venueId, tab.check_id, input.now);
  const need = await tabNeed(c, venueId, tab, input.now);
  if (need.balanceCents <= 0)
    throw new ApiError("invalid_request", "nothing is due on this tab", {
      details: { reason: "nothing_due" },
    });
  const drinks = view.lines
    .filter((l) => ["item", "comp", "void", "discount"].includes(l.kind))
    .reduce((sum, l) => sum + l.amount_cents, 0);
  const gratuity = view.totals?.gratuity_cents ?? 0;
  if (input.path === "slip") {
    // The paper slip: it prints at the bar, the hold stays, and the tip goes in from Tips to enter.
    await c.query(
      `insert into tab_closings (venue_id, tab_id, check_id, payment_id, path, state, balance_cents, drinks_cents,
         gratuity_cents, closed_by, created_at, slip_printed_at)
       values ($1, $2, $3, $4, 'slip', 'slip', $5, $6, $7, $8, $9, $9)`,
      [
        venueId,
        tabId,
        tab.check_id,
        tab.payment_id,
        need.balanceCents,
        drinks,
        gratuity,
        input.userId,
        input.now.toString(),
      ],
    );
    await printSlip(c, venueId, {
      tabId,
      checkId: tab.check_id,
      totalCents: need.balanceCents,
      now: input.now,
    });
    return { kind: "slip" };
  }
  const screen = await tipScreen(c, venueId, input.now);
  // A gratuity on the tab: the reader skips the tip, and the receipt reads "Gratuity included".
  const path = input.path === "reader" && gratuity === 0 ? "reader" : "none";
  const choices = path === "reader" && screen ? tipChoices(drinks, screen) : null;
  await moveTab(c, venueId, tabId, "tipping");
  const closingId = (
    await c.query<{ id: string }>(
      `insert into tab_closings (venue_id, tab_id, check_id, payment_id, path, reader_device_id, stripe_reader_id,
         state, step_no, step_started_at, balance_cents, drinks_cents, gratuity_cents, tip_kind, choices_cents,
         closed_by, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $10) returning id`,
      [
        venueId,
        tabId,
        tab.check_id,
        tab.payment_id,
        path,
        path === "reader" ? reader!.id : null,
        path === "reader" ? reader!.stripe_reader_id : null,
        path === "reader" ? "asking" : "capturing",
        path === "reader" ? 1 : 0,
        input.now.toString(),
        need.balanceCents,
        drinks,
        gratuity,
        choices?.kind ?? null,
        choices?.choicesCents ?? [],
        input.userId,
      ],
    )
  ).rows[0]!.id;
  await emitEvent(c, { venueId, type: "tab.updated", entityId: tabId });
  if (path === "reader") {
    await enqueueCloseCheck(c, venueId, closingId, input.now.add({ seconds: POLL_S }), 1);
    return { kind: "asking", closingId };
  }
  const closing = (await closingById(c, venueId, closingId, true))!;
  await planCapture(c, venueId, closing, { tipCents: 0, choice: "none" }, input.now);
  return { kind: "run", closingId, paymentId: tab.payment_id };
}

async function enqueueCloseCheck(
  c: Queryable,
  venueId: string,
  closingId: string,
  at: Temporal.Instant,
  n: number,
) {
  await enqueue(c, {
    venueId,
    kind: TAB_CLOSE_CHECK_KIND,
    pool: "critical",
    dedupeKey: `${TAB_CLOSE_CHECK_KIND}:${closingId}:${n}`,
    payload: { closing_id: closingId, n },
    runAt: at,
    maxAttempts: 3,
  });
}

/**
 * The tip is known: it's recorded with set_tip() and kept as evidence, and the total plus the tip is
 * captured in one call, or the hold raised first, or the tab left for a manager when nothing covers it.
 */
export async function planCapture(
  c: Queryable,
  venueId: string,
  closing: ClosingRow,
  tip: { tipCents: number; choice: string; readerAnswer?: boolean },
  now: Temporal.Instant,
) {
  await setTip(c, closing.payment_id, tip.tipCents);
  const amount = closing.balance_cents + tip.tipCents;
  await c.query(
    `update tab_closings set tip_choice = $3, tip_cents = $4, capture_cents = $5,
            tip_picked_at = case when $6 then $7::timestamptz else tip_picked_at end
      where venue_id = $1 and id = $2`,
    [
      venueId,
      closing.id,
      tip.choice,
      tip.tipCents,
      amount,
      tip.readerAnswer ?? false,
      now.toString(),
    ],
  );
  await nextStep(c, venueId, { ...closing, tip_cents: tip.tipCents, capture_cents: amount }, now);
}

/** The capture, or the raise before it, as the hold allows (packages/rules · closePlan). */
async function nextStep(c: Queryable, venueId: string, closing: ClosingRow, now: Temporal.Instant) {
  const tab = await tabById(c, venueId, closing.tab_id);
  const card = holdCardOf(tab);
  if (!card) return failClose(c, venueId, closing, now);
  const plan = closePlan(card, closing.capture_cents!);
  if (plan.kind === "over") return failClose(c, venueId, closing, now);
  if (plan.kind === "raise") {
    await startAttempt(c, venueId, {
      paymentId: closing.payment_id,
      checkId: closing.check_id,
      portionKey: "tab",
      action: "increment",
      amountCents: plan.targetCents,
      keySuffix: String(plan.targetCents),
      startedAt: now.toString(),
    }).then(async ({ attemptNo }) => {
      await c.query(
        "update payments set increments_used = increments_used + 1 where venue_id = $1 and id = $2",
        [venueId, closing.payment_id],
      );
      await enqueueRun(c, venueId, closing.payment_id, attemptNo, now);
    });
    await setState(c, venueId, closing.id, "raising");
    return;
  }
  // The total goes on the check as this payment's, in progress until Stripe captures it; the tip never does.
  await setAllocationState(c, venueId, closing.payment_id, "in_progress", "released");
  await allocate(c, venueId, {
    paymentId: closing.payment_id,
    checkId: closing.check_id,
    amountCents: closing.balance_cents,
    state: "in_progress",
  });
  const { attemptNo } = await startAttempt(c, venueId, {
    paymentId: closing.payment_id,
    checkId: closing.check_id,
    portionKey: "tab",
    action: "capture",
    amountCents: plan.captureCents,
    keySuffix: String(plan.captureCents),
    startedAt: now.toString(),
  });
  await enqueueRun(c, venueId, closing.payment_id, attemptNo, now);
  await setState(c, venueId, closing.id, "capturing");
}

async function setState(c: Queryable, venueId: string, id: string, state: ClosingState) {
  const settled = !ACTIVE.includes(state);
  await c.query(
    `update tab_closings set state = $3, settled_at = case when $4 then now() else settled_at end
      where venue_id = $1 and id = $2`,
    [venueId, id, state, settled],
  );
}

/** The hold can't cover the total: nothing is captured, and the tab waits for a manager. */
async function failClose(
  c: Queryable,
  venueId: string,
  closing: ClosingRow,
  now: Temporal.Instant,
) {
  await setState(c, venueId, closing.id, "failed");
  await setAllocationState(c, venueId, closing.payment_id, "in_progress", "released");
  await setTip(c, closing.payment_id, 0);
  await moveTab(c, venueId, closing.tab_id, "capture_failed");
  await emitEvent(c, { venueId, type: "tab.updated", entityId: closing.tab_id });
  await emitEvent(c, { venueId, type: "check.updated", entityId: closing.check_id });
  void now;
}

/**
 * Cancel on the reader or on the screen, or no answer in 2 minutes: the tab is open again, its check
 * takes drinks again, and nothing was charged.
 */
async function backToOpen(
  c: Queryable,
  venueId: string,
  closing: ClosingRow,
  state: "canceled" | "timed_out",
) {
  await setState(c, venueId, closing.id, state);
  await moveTab(c, venueId, closing.tab_id, "open");
  await reopenCheck(c, venueId, closing.check_id);
  await emitEvent(c, { venueId, type: "tab.updated", entityId: closing.tab_id });
}

/**
 * A tip screen nobody answered (2 minutes, or the reader's own timeout): the question is down, the paper
 * slip prints at the bar, and the tab waits as `awaiting_tip` with its hold standing (M6-09).
 */
async function toSlip(c: Queryable, venueId: string, closing: ClosingRow, now: Temporal.Instant) {
  await c.query(
    `update tab_closings set state = 'slip', slip_printed_at = $3 where venue_id = $1 and id = $2`,
    [venueId, closing.id, now.toString()],
  );
  await printSlip(c, venueId, {
    tabId: closing.tab_id,
    checkId: closing.check_id,
    totalCents: closing.balance_cents,
    now,
  });
}

/**
 * Inside the payment state machine's transaction: a raise or a capture of a closing tab is known. A raise
 * that reached the total writes the capture; a capture that went through closes the tab as `captured`;
 * anything that failed leaves it `capture_failed`. Answers whether anything changed.
 */
export async function settleClose(
  c: Queryable,
  venueId: string,
  payment: PaymentRow,
  attempt: AttemptRow,
  now: Temporal.Instant,
): Promise<boolean> {
  const closing = await activeClosingOfPayment(c, venueId, payment.id);
  if (!closing) return false;
  if (closing.state === "raising" && attempt.action === "increment") {
    if (attempt.state === "succeeded") {
      await nextStep(c, venueId, closing, now);
      return true;
    }
    if (attempt.state === "failed" || attempt.state === "canceled") {
      await failClose(c, venueId, closing, now);
      return true;
    }
    return false;
  }
  if (closing.state !== "capturing" || attempt.action !== "capture") return false;
  if (payment.status === "captured") {
    await setState(c, venueId, closing.id, "captured");
    await moveTab(c, venueId, closing.tab_id, "captured");
    await c.query(
      "update tabs set closed_at = $3, closed_by = $4 where venue_id = $1 and id = $2",
      [venueId, closing.tab_id, now.toString(), closing.closed_by],
    );
    await emitEvent(c, { venueId, type: "tab.updated", entityId: closing.tab_id });
    return true;
  }
  if (attempt.state === "failed" || attempt.state === "canceled") {
    await failClose(c, venueId, closing, now);
    return true;
  }
  return false;
}

/** Puts the current question on the reader, outside any transaction. Answers what went wrong, if anything. */
export async function askReader(
  deps: PaymentDeps,
  venueId: string,
  closingId: string,
): Promise<"asked" | "offline" | "busy" | "unclear" | null> {
  const inVenue = <T>(work: (c: Queryable) => Promise<T>) =>
    withVenue(deps.pool, { venueId, requestId: `tab-close:${closingId}` }, work);
  const ctx = await inVenue(async (c) => {
    const closing = await closingById(c, venueId, closingId);
    if (!closing || !closing.stripe_reader_id) return null;
    const receipt = closing.receipt === "text" && !closing.receipt_sent_at;
    if (!receipt && closing.state !== "asking" && closing.state !== "custom") return null;
    return {
      closing,
      receipt,
      account: await stripeAccountOf(c, venueId),
      question: receipt
        ? ({ type: "phone", title: "Text me the receipt" } as const)
        : await readerQuestion(c, venueId, closing, deps.clock.now()),
    };
  });
  if (!ctx?.account) return null;
  const step = ctx.receipt ? receiptTag(ctx.closing) : stepTag(ctx.closing);
  try {
    await collectInputs(
      deps.stripe,
      ctx.account,
      { readerId: ctx.closing.stripe_reader_id!, question: ctx.question, step },
      `${step}:collect_inputs`,
    );
    return "asked";
  } catch (e) {
    if (e instanceof StripeUnknownResult) return "unclear";
    if (!(e instanceof StripeError)) throw e;
    const code = e.code ?? e.type;
    const answer = code === "terminal_reader_busy" ? "busy" : "offline";
    // The reader couldn't ask: the tip screen never showed, so the tab is open again (or no receipt).
    await inVenue(async (c) => {
      const closing = (await closingById(c, venueId, closingId, true))!;
      if (ctx.receipt)
        await c.query("update tab_closings set receipt = null where venue_id = $1 and id = $2", [
          venueId,
          closingId,
        ]);
      else if (closing.state === "asking" || closing.state === "custom")
        await backToOpen(c, venueId, closing, "canceled");
    });
    return answer;
  }
}

/**
 * Reads the reader's answer (the close-check job every 2 seconds, check-status and webhooks): a tip picked
 * writes the capture, Custom asks for the number, Cancel puts the tab back to open, and a tip screen
 * untouched for 2 minutes is canceled. A texted receipt's phone number is sent here too.
 */
export async function checkClose(
  deps: PaymentDeps & { readonly receipts?: ReceiptDeps | null },
  venueId: string,
  closingId: string,
): Promise<void> {
  const inVenue = <T>(work: (c: Queryable) => Promise<T>) =>
    withVenue(deps.pool, { venueId, requestId: `tab-close:${closingId}` }, work);
  const first = await inVenue(async (c) => ({
    closing: await closingById(c, venueId, closingId),
    account: await stripeAccountOf(c, venueId),
  }));
  const closing = first.closing;
  if (!closing || !first.account || !closing.stripe_reader_id) {
    if (closing) await driveClose(deps, venueId, closing.payment_id);
    return;
  }
  const asking = closing.state === "asking" || closing.state === "custom";
  const receipt = closing.receipt === "text" && !closing.receipt_sent_at;
  if (!asking && !receipt) {
    await driveClose(deps, venueId, closing.payment_id);
    return;
  }
  let answer: ReturnType<typeof inputsAnswerOf> = null;
  try {
    answer = inputsAnswerOf(
      await retrieveReader(deps.stripe, first.account, closing.stripe_reader_id),
    );
  } catch (e) {
    if (!(e instanceof StripeError || e instanceof StripeUnknownResult)) throw e;
  }
  const now = deps.clock.now();
  if (receipt && !asking) {
    if (answer?.step !== receiptTag(closing) || answer.status === "in_progress") return;
    await inVenue(async (c) => {
      const locked = (await closingById(c, venueId, closingId, true))!;
      if (locked.receipt_sent_at || locked.receipt !== "text" || !deps.receipts) return;
      const phone = answer.status === "succeeded" ? toPhone(answer.value) : null;
      if (!phone) {
        await c.query("update tab_closings set receipt = null where venue_id = $1 and id = $2", [
          venueId,
          closingId,
        ]);
        return;
      }
      await sendReceipt(c, venueId, deps.receipts, {
        checkId: closing.check_id,
        to: { channel: "text", to: phone },
        paymentId: closing.payment_id,
        sentBy: closing.closed_by,
        now,
      });
      await c.query(
        "update tab_closings set receipt_sent_at = $3 where venue_id = $1 and id = $2",
        [venueId, closingId, now.toString()],
      );
      await emitEvent(c, { venueId, type: "tab.updated", entityId: closing.tab_id });
    });
    return;
  }
  const mine = answer?.step === stepTag(closing);
  const started = closing.step_started_at ? Date.parse(closing.step_started_at) : 0;
  const untouched = now.epochMilliseconds - started >= TIP_SCREEN_S * 1000;
  if (!mine || answer!.status === "in_progress") {
    if (!untouched) return;
    // No answer in 2 minutes: the tip screen is taken down, and the paper slip prints.
    await cancelReaderAction(
      deps.stripe,
      first.account,
      closing.stripe_reader_id,
      `${stepTag(closing)}:cancel_action`,
    ).catch(() => undefined);
    await inVenue(async (c) => {
      const locked = (await closingById(c, venueId, closingId, true))!;
      if (locked.state === "asking" || locked.state === "custom")
        await toSlip(c, venueId, locked, now);
    });
    return;
  }
  const settled = await inVenue(async (c) => {
    const locked = (await closingById(c, venueId, closingId, true))!;
    if (locked.step_no !== closing.step_no || !["asking", "custom"].includes(locked.state))
      return "stale" as const;
    if (answer!.status === "failed") {
      // The reader's own timeout is a tip screen nobody touched: the slip prints. Cancel is back to open.
      if (answer!.failureCode === "terminal_reader_timeout") await toSlip(c, venueId, locked, now);
      else await backToOpen(c, venueId, locked, "canceled");
      return "back" as const;
    }
    const tip = tipOf(locked, answer!.value);
    if (tip === "custom" || tip === null) {
      // Custom asks for the number; a number that isn't one asks again.
      await c.query(
        `update tab_closings set state = 'custom', step_no = step_no + 1, step_started_at = $3
          where venue_id = $1 and id = $2`,
        [venueId, closingId, now.toString()],
      );
      return "ask" as const;
    }
    await planCapture(c, venueId, locked, { ...tip, readerAnswer: true }, now);
    await emitEvent(c, { venueId, type: "tab.updated", entityId: locked.tab_id });
    return "run" as const;
  });
  if (settled === "ask") await askReader(deps, venueId, closingId);
  if (settled === "run") await driveClose(deps, venueId, closing.payment_id);
}

/** What the guest's answer means: a choice's amount, No tip, Custom (ask the number), or a number typed. */
function tipOf(
  closing: ClosingRow,
  value: string | null,
): { tipCents: number; choice: string } | "custom" | null {
  if (closing.state === "custom") {
    const dollars = Number((value ?? "").trim());
    if (!/^\d{1,4}$/.test((value ?? "").trim()) || !Number.isInteger(dollars)) return null;
    return { tipCents: dollars * 100, choice: "custom" };
  }
  if (value === "none") return { tipCents: 0, choice: "none" };
  if (value === "custom") return "custom";
  const i = /^tip_(\d)$/.exec(value ?? "")?.[1];
  const amount = i !== undefined ? closing.choices_cents[Number(i)] : undefined;
  if (amount === undefined) return null;
  return {
    tipCents: amount,
    choice: closing.tip_kind === "fixed" ? `fixed_${amount}` : `choice_${Number(i) + 1}`,
  };
}

const toPhone = (value: string | null): string | null => {
  const digits = (value ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return null;
};

/**
 * Runs the closing payment's queued step here and now (a raise, then the capture it writes), as the
 * worker would; each claims its job with a lease, so a dead process is picked up by the worker.
 */
export async function driveClose(deps: PaymentDeps, venueId: string, paymentId: string) {
  for (let i = 0; i < 3; i++) {
    const attempt = await withVenue(
      deps.pool,
      { venueId, requestId: `tab-close:${paymentId}` },
      (c) => latestAttempt(c, venueId, paymentId),
    );
    if (!attempt || attempt.state !== "started") return;
    if (!(await runNow(deps, venueId, paymentId, attempt.attempt_no))) return;
  }
}

/** Cancel from the screen while the reader asks: the reader's question comes down, and the tab is open. */
export async function cancelClose(deps: PaymentDeps, venueId: string, closingId: string) {
  const inVenue = <T>(work: (c: Queryable) => Promise<T>) =>
    withVenue(deps.pool, { venueId, requestId: `tab-close:${closingId}` }, work);
  const ctx = await inVenue(async (c) => ({
    closing: await closingById(c, venueId, closingId),
    account: await stripeAccountOf(c, venueId),
  }));
  const closing = ctx.closing;
  if (!closing || (closing.state !== "asking" && closing.state !== "custom")) return;
  if (ctx.account && closing.stripe_reader_id)
    await cancelReaderAction(
      deps.stripe,
      ctx.account,
      closing.stripe_reader_id,
      `${stepTag(closing)}:cancel_action`,
    ).catch(() => undefined);
  await inVenue(async (c) => {
    const locked = (await closingById(c, venueId, closingId, true))!;
    if (locked.state === "asking" || locked.state === "custom")
      await backToOpen(c, venueId, locked, "canceled");
  });
}

/** The close-check job: reads the reader every 2 seconds while it asks, then stops. */
export async function closeCheckJob(
  deps: PaymentDeps,
  venueId: string,
  payload: { closing_id: string; n: number },
) {
  await checkClose(deps, venueId, payload.closing_id);
  await withVenue(
    deps.pool,
    { venueId, requestId: `tab-close:${payload.closing_id}:job` },
    async (c) => {
      const closing = await closingById(c, venueId, payload.closing_id);
      if (closing && (closing.state === "asking" || closing.state === "custom"))
        await enqueueCloseCheck(
          c,
          venueId,
          closing.id,
          deps.clock.now().add({ seconds: POLL_S }),
          payload.n + 1,
        );
    },
  );
}

/** The Receipt step after a close: Text puts a phone number question on the reader; Print prints at the bar. */
export async function chooseReceipt(
  c: Queryable,
  venueId: string,
  closingId: string,
  input: {
    choice: "text" | "print" | "none";
    receipts: ReceiptDeps;
    userId: string;
    now: Temporal.Instant;
  },
) {
  const closing = await closingById(c, venueId, closingId, true);
  if (!closing || closing.state !== "captured")
    throw new ApiError("invalid_request", "the tab isn't paid yet", {
      details: { reason: "not_captured" },
    });
  if (input.choice === "text" && !closing.stripe_reader_id)
    throw new ApiError("invalid_request", "no reader to type the number on", {
      details: { reason: "reader" },
    });
  if (input.choice === "print")
    await sendReceipt(c, venueId, input.receipts, {
      checkId: closing.check_id,
      to: { channel: "print", station: "bar" },
      paymentId: closing.payment_id,
      sentBy: input.userId,
      now: input.now,
    });
  await c.query(
    `update tab_closings set receipt = $3,
            receipt_step_no = case when $3 = 'text' then coalesce(receipt_step_no, 0) + 1 else receipt_step_no end,
            receipt_sent_at = case when $3 = 'text' then null else $4::timestamptz end
      where venue_id = $1 and id = $2`,
    [venueId, closingId, input.choice, input.now.toString()],
  );
  if (input.choice === "print")
    await c.query("update tabs set receipt_printed_at = $3 where venue_id = $1 and id = $2", [
      venueId,
      closing.tab_id,
      input.now.toString(),
    ]);
}

/** The Close as the bar POS shows it: the reader's question, the tip picked, the payment's state. */
export async function closeView(c: Queryable, venueId: string, closing: ClosingRow) {
  const payment = (await paymentById(c, venueId, closing.payment_id))!;
  const attempt = await latestAttempt(c, venueId, closing.payment_id);
  const tab = (
    await c.query<{ state: string }>("select state from tabs where venue_id = $1 and id = $2", [
      venueId,
      closing.tab_id,
    ])
  ).rows[0]!;
  return {
    id: closing.id,
    tab_id: closing.tab_id,
    tab_state: tab.state,
    check_id: closing.check_id,
    path: closing.path,
    state: closing.state,
    reader_id: closing.reader_device_id,
    balance_cents: closing.balance_cents,
    drinks_cents: closing.drinks_cents,
    gratuity_cents: closing.gratuity_cents,
    tip_choices: closing.tip_kind
      ? { kind: closing.tip_kind, choices_cents: closing.choices_cents }
      : null,
    tip_choice: closing.tip_choice,
    tip_cents: closing.tip_cents,
    capture_cents: closing.capture_cents,
    payment: {
      id: payment.id,
      status: payment.status,
      state: screenState(payment, attempt),
      unknown: attempt !== null && attempt.state === "unknown",
    },
    receipt: closing.receipt,
    receipt_sent: closing.receipt_sent_at !== null,
    slip_printed_at: closing.slip_printed_at,
  };
}
