import {
  allocate,
  emitEvent,
  enqueue,
  insertPayment,
  isNightClosed,
  readerOfVenue,
  stripeAccountOf,
  withVenue,
  type Queryable,
} from "@west4/db";
import { businessDate } from "@west4/rules";
import { cents, formatMoney, type Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { venueClock } from "../rooms/assignment.js";
import { tabHoldOf } from "../payments/splits.js";
import { chargeNow, goAhead, waitingOnFile } from "../payments/card-on-file.js";
import { cancelPayment, type PaymentDeps } from "../payments/run.js";
import { StripeError, StripeUnknownResult, type StripeClient } from "../stripe/client.js";
import { cancelReaderAction } from "../stripe/payments.js";
import { collectInputs, inputsAnswerOf } from "../stripe/tabs.js";
import { retrieveReader } from "../stripe/terminal.js";
import { startTabPayment } from "./pay.js";
import { moveTab } from "./state.js";

/**
 * Charge the saved card on a reopened tab (M6-12; Payment flows · Bar tab with a growing hold, step 9;
 * API · Bar tabs `/charge-saved-card`). A reopened tab whose hold was captured has no hold; new drinks
 * can go on the card saved from the first tap (the reader's `generated_card`), charged off-session. The
 * charge is M4-17's card-on-file payment: it waits with its amount held for the go-ahead, which is the
 * guest's Yes on the bar reader (`collect_inputs`, kept in `tab_card_confirms` as evidence) or a
 * manager's approval (`202`, kind `card_on_file`, the reason kept as `mit_reason`). The charge runs in
 * the `payment.run` job, outside any transaction, keyed `<payment_id>:off_session:<n>`. No or Cancel on
 * the reader, or a declined charge, cancels it, and the tab takes drinks again.
 */
export const TAB_CARD_CONFIRM_KIND = "tab.card_confirm";
/** The question stays on the reader this long, as the tip screen does (M6-08). */
export const CONFIRM_SCREEN_S = 120;
const POLL_S = 2;

const BRANDS: Record<string, string> = {
  amex: "Amex",
  visa: "Visa",
  mastercard: "Mastercard",
  discover: "Discover",
};

export interface TabSavedCard {
  readonly tab_id: string;
  readonly check_id: string;
  readonly name: string;
  /** The tab's first payment (its hold), whose PaymentIntent names the Stripe Customer. */
  readonly hold_payment_id: string;
  readonly hold_pi_id: string | null;
  /** The card saved from the first tap; a wallet tap may leave none. */
  readonly payment_method: string;
  readonly brand: string | null;
  readonly last4: string | null;
}

/** The card saved from a tab's first tap, if the reader generated one. */
export async function tabSavedCard(
  c: Queryable,
  venueId: string,
  checkId: string,
): Promise<TabSavedCard | null> {
  const r = await c.query<TabSavedCard>(
    `select t.id as tab_id, t.check_id, t.name, p.id as hold_payment_id, p.stripe_pi_id as hold_pi_id,
            p.generated_card_pm as payment_method, t.card_brand as brand, t.card_last4 as last4
       from tabs t join payments p on p.venue_id = t.venue_id and p.id = t.payment_id
      where t.venue_id = $1 and t.check_id = $2 and p.generated_card_pm is not null`,
    [venueId, checkId],
  );
  return r.rows[0] ?? null;
}

/** "Visa ··4417", as the bar screen and the reader say it. */
export const cardWords = (card: Pick<TabSavedCard, "brand" | "last4">) =>
  `${BRANDS[card.brand ?? ""] ?? card.brand ?? ""} ··${card.last4 ?? ""}`.trim();

/** The Customer and saved card for the off-session charge, read from the hold's PaymentIntent. */
export async function tabCardForCharge(
  stripe: StripeClient,
  account: string,
  card: TabSavedCard,
): Promise<{ customer: string; paymentMethod: string } | null> {
  if (!card.hold_pi_id) return null;
  const pi = await stripe.call<{ customer: string | null }>(
    "payments",
    "GET",
    `/v1/payment_intents/${encodeURIComponent(card.hold_pi_id)}`,
    { account },
  );
  return pi.customer ? { customer: pi.customer, paymentMethod: card.payment_method } : null;
}

/**
 * Settled tonight → open again (Reopen), with what was paid kept as paid. A tab whose hold was captured
 * (or canceled once another payment replaced it) has no hold from here on. Inside the caller's
 * transaction.
 */
export async function reopenTab(
  c: Queryable,
  venueId: string,
  tabId: string,
  input: { now: Temporal.Instant },
) {
  const r = await c.query<{
    state: string;
    check_id: string;
    card_fingerprint: string | null;
    business_date: string;
    hold_status: string | null;
    moved: boolean;
  }>(
    `select t.state, t.check_id, t.card_fingerprint, k.business_date::text, p.status as hold_status,
            t.moved_to_check_id is not null as moved
       from tabs t join checks k on k.venue_id = t.venue_id and k.id = t.check_id
       left join payments p on p.venue_id = t.venue_id and p.id = t.payment_id
      where t.venue_id = $1 and t.id = $2 for update of t`,
    [venueId, tabId],
  );
  const tab = r.rows[0];
  if (!tab) throw new ApiError("not_found", "no such tab");
  if (!["captured", "walkout_captured", "closed"].includes(tab.state))
    throw new ApiError("invalid_request", `a ${tab.state} tab isn't reopened`, {
      details: { reason: "tab_state", state: tab.state },
    });
  // A tab moved into a room has nothing left on it (M6-13): its drinks are the room's now.
  if (tab.moved)
    throw new ApiError("invalid_request", "this tab moved into a room", {
      details: { reason: "moved_to_room" },
    });
  // Until the night closes (M7-02's closed-night guard): only tonight's tabs come back, and never one whose
  // night has closed, even before the 6:00 AM cutover.
  const venue = await venueClock(c, venueId);
  const tonight = businessDate(input.now, venue.timeZone, venue.dayCutover).businessDate.toString();
  if (tab.business_date !== tonight || (await isNightClosed(c, venueId, tab.business_date)))
    throw new ApiError("invalid_request", "that tab is from an earlier night", {
      details: { reason: "night_closed" },
    });
  // A hold still being released after another payment replaced it is gone in a moment: never revived.
  if (tab.hold_status === "authorized")
    throw new ApiError("in_progress", "the tab's hold is still being released", {
      details: { reason: "hold_releasing" },
    });
  // One open tab per card: the same card may have opened a new one since.
  if (tab.card_fingerprint) {
    const other = await c.query<{ name: string }>(
      `select name from tabs where venue_id = $1 and card_fingerprint = $2 and id <> $3
          and state in ('open', 'tipping')`,
      [venueId, tab.card_fingerprint, tabId],
    );
    if (other.rows[0])
      throw new ApiError("invalid_request", "that card has another open tab", {
        details: { reason: "card_has_open_tab", tab: other.rows[0].name },
      });
  }
  await moveTab(c, venueId, tabId, "open");
  await c.query(
    `update tabs set closed_at = null, closed_by = null, reopened_at = $3, hold_declined_at = null
      where venue_id = $1 and id = $2`,
    [venueId, tabId, input.now.toString()],
  );
  // What was paid stays paid; the check takes drinks again, and the next finalize writes a new revision.
  await c.query(
    `update checks set status = 'reopened', version = version + 1
      where venue_id = $1 and id = $2 and status in ('paid', 'finalized', 'partly_paid')`,
    [venueId, tab.check_id],
  );
  await emitEvent(c, { venueId, type: "tab.updated", entityId: tabId });
  return { tabId, checkId: tab.check_id };
}

export interface StartSavedCharge {
  readonly userId: string;
  readonly amountCents: number;
  /** The bar reader that asks the guest; null when a manager is asked instead. */
  readonly readerDeviceId: string | null;
  readonly now: Temporal.Instant;
  readonly readerQuiet: (
    c: Queryable,
    venueId: string,
    deviceId: string,
    now: Temporal.Instant,
  ) => Promise<boolean>;
}

/**
 * Charge the saved card (inside the caller's transaction): the tab is open with no hold and a saved
 * card, nothing else being paid, not split; the check is finalized and the payment waits for the
 * go-ahead with the balance held. With a reader, the question is written here and asked outside.
 */
export async function startSavedCharge(
  c: Queryable,
  venueId: string,
  tabId: string,
  input: StartSavedCharge,
): Promise<{ paymentId: string; confirmId: string | null; card: TabSavedCard }> {
  const t = await c.query<{ check_id: string }>(
    "select check_id from tabs where venue_id = $1 and id = $2",
    [venueId, tabId],
  );
  const checkId = t.rows[0]?.check_id;
  if (!checkId) throw new ApiError("not_found", "no such tab");
  // A tab with its hold standing closes to that card; the saved card is for a reopened tab.
  if (await tabHoldOf(c, venueId, checkId))
    throw new ApiError("invalid_request", "this tab has its hold: close it to the card", {
      details: { reason: "has_hold" },
    });
  const card = await tabSavedCard(c, venueId, checkId);
  if (!card)
    throw new ApiError("invalid_request", "this tab has no saved card", {
      details: { reason: "no_saved_card" },
    });
  let reader: { id: string; stripe_reader_id: string } | null = null;
  if (input.readerDeviceId) {
    reader = await readerOfVenue(c, venueId, input.readerDeviceId);
    if (!reader) throw new ApiError("not_found", "no such reader");
    if (await input.readerQuiet(c, venueId, input.readerDeviceId, input.now))
      throw new ApiError("reader_offline", "the bar reader is offline: ask a manager instead", {
        details: { reader_id: input.readerDeviceId },
      });
  }
  const started = await startTabPayment(c, venueId, tabId, {
    userId: input.userId,
    amountCents: input.amountCents,
    now: input.now,
  });
  const venue = await venueClock(c, venueId);
  const paymentId = await insertPayment(c, venueId, {
    method: "card_on_file",
    status: "pending",
    businessDate: businessDate(input.now, venue.timeZone, venue.dayCutover).businessDate.toString(),
  });
  // Never more than the amount due, and the amount held so nothing else takes the same money.
  await allocate(c, venueId, {
    paymentId,
    checkId,
    amountCents: started.balanceCents,
    state: "in_progress",
  });
  let confirmId: string | null = null;
  if (reader) {
    const ins = await c.query<{ id: string }>(
      `insert into tab_card_confirms (venue_id, tab_id, check_id, payment_id, amount_cents, reader_device_id,
         stripe_reader_id, state, asked_by, asked_at)
       values ($1, $2, $3, $4, $5, $6, $7, 'asking', $8, $9) returning id`,
      [
        venueId,
        tabId,
        checkId,
        paymentId,
        started.balanceCents,
        reader.id,
        reader.stripe_reader_id,
        input.userId,
        input.now.toString(),
      ],
    );
    confirmId = ins.rows[0]!.id;
    await enqueueConfirmCheck(c, venueId, confirmId, input.now.add({ seconds: POLL_S }), 1);
  }
  await emitEvent(c, { venueId, type: "tab.updated", entityId: tabId });
  return { paymentId, confirmId, card };
}

interface ConfirmRow {
  id: string;
  tab_id: string;
  check_id: string;
  payment_id: string;
  amount_cents: number;
  stripe_reader_id: string;
  state: string;
  asked_at: string;
}
const CONFIRM_COLS = `id, tab_id, check_id, payment_id, amount_cents, stripe_reader_id, state,
  to_json(asked_at) #>> '{}' as asked_at`;

export async function confirmById(c: Queryable, venueId: string, id: string, lock = false) {
  const r = await c.query<ConfirmRow>(
    `select ${CONFIRM_COLS} from tab_card_confirms where venue_id = $1 and id = $2${lock ? " for update" : ""}`,
    [venueId, id],
  );
  return r.rows[0] ?? null;
}

/** The question on the reader for a payment, newest first. */
export async function confirmOfPayment(c: Queryable, venueId: string, paymentId: string) {
  const r = await c.query<ConfirmRow>(
    `select ${CONFIRM_COLS} from tab_card_confirms where venue_id = $1 and payment_id = $2
      order by asked_at desc, id desc limit 1`,
    [venueId, paymentId],
  );
  return r.rows[0] ?? null;
}

const stepOf = (id: string) => `confirm:${id}`;

async function enqueueConfirmCheck(
  c: Queryable,
  venueId: string,
  confirmId: string,
  at: Temporal.Instant,
  n: number,
) {
  await enqueue(c, {
    venueId,
    kind: TAB_CARD_CONFIRM_KIND,
    pool: "critical",
    dedupeKey: `${TAB_CARD_CONFIRM_KIND}:${confirmId}:${n}`,
    payload: { confirm_id: confirmId, n },
    runAt: at,
    maxAttempts: 3,
  });
}

type ChargeDeps = PaymentDeps & {
  readonly payAppUrl?: string | null;
  readonly texts?: { readonly allowList: readonly string[] | null };
};

/** Ends a question that didn't go ahead: the payment is cancelled (outside any transaction). */
async function endConfirm(
  deps: ChargeDeps,
  venueId: string,
  confirm: ConfirmRow,
  state: "no" | "timed_out" | "offline" | "canceled",
) {
  const ended = await withVenue(
    deps.pool,
    { venueId, requestId: `tab-confirm:${confirm.id}` },
    async (c) => {
      const locked = (await confirmById(c, venueId, confirm.id, true))!;
      if (locked.state !== "asking") return false;
      await c.query(
        "update tab_card_confirms set state = $3, answered_at = $4 where venue_id = $1 and id = $2",
        [venueId, confirm.id, state, deps.clock.now().toString()],
      );
      // Still waiting for a go-ahead (no manager approved meanwhile): nothing is charged.
      return (await waitingOnFile(c, venueId, confirm.payment_id)) !== null;
    },
  );
  if (ended) await cancelPayment(deps, venueId, confirm.payment_id, "api");
}

/** Puts the Yes/No question on the bar reader, outside any transaction. */
export async function askSavedCard(
  deps: ChargeDeps,
  venueId: string,
  confirmId: string,
): Promise<"asked" | "offline" | "busy" | "unclear" | null> {
  const ctx = await withVenue(
    deps.pool,
    { venueId, requestId: `tab-confirm:${confirmId}` },
    async (c) => {
      const confirm = await confirmById(c, venueId, confirmId);
      if (!confirm || confirm.state !== "asking") return null;
      const card = await tabSavedCard(c, venueId, confirm.check_id);
      return { confirm, card, account: await stripeAccountOf(c, venueId) };
    },
  );
  if (!ctx?.account || !ctx.card) return null;
  const amount = formatMoney("en", cents(ctx.confirm.amount_cents));
  try {
    await collectInputs(
      deps.stripe,
      ctx.account,
      {
        readerId: ctx.confirm.stripe_reader_id,
        question: {
          type: "selection",
          title: `Charge ${amount} to ${cardWords(ctx.card)}?`,
          choices: [
            { id: "yes", text: "Yes" },
            { id: "no", text: "No" },
          ],
        },
        step: stepOf(confirmId),
      },
      `${stepOf(confirmId)}:collect_inputs`,
    );
    return "asked";
  } catch (e) {
    if (e instanceof StripeUnknownResult) return "unclear";
    if (!(e instanceof StripeError)) throw e;
    const code = e.code ?? e.type;
    // The reader couldn't ask: the payment waits on, and staff can ask a manager instead.
    await withVenue(deps.pool, { venueId, requestId: `tab-confirm:${confirmId}` }, async (c) => {
      await c.query(
        `update tab_card_confirms set state = 'offline', answered_at = $3
          where venue_id = $1 and id = $2 and state = 'asking'`,
        [venueId, confirmId, deps.clock.now().toString()],
      );
    });
    return code === "terminal_reader_busy" ? "busy" : "offline";
  }
}

/**
 * Reads the guest's answer (the job every 2 seconds, check-status and the reader's webhook): Yes runs
 * the off-session charge; No, Cancel or the reader's timeout cancels the payment; a question untouched for
 * 2 minutes is taken down. A payment that went ahead another way (a manager approved) takes it down too.
 */
export async function checkSavedCard(deps: ChargeDeps, venueId: string, confirmId: string) {
  const first = await withVenue(
    deps.pool,
    { venueId, requestId: `tab-confirm:${confirmId}` },
    async (c) => ({
      confirm: await confirmById(c, venueId, confirmId),
      account: await stripeAccountOf(c, venueId),
    }),
  );
  const confirm = first.confirm;
  if (!confirm || confirm.state !== "asking" || !first.account) return;
  const takeDown = () =>
    cancelReaderAction(
      deps.stripe,
      first.account!,
      confirm.stripe_reader_id,
      `${stepOf(confirm.id)}:cancel_action`,
    ).catch(() => undefined);
  const stillWaiting = await withVenue(
    deps.pool,
    { venueId, requestId: `tab-confirm:${confirmId}` },
    async (c) => (await waitingOnFile(c, venueId, confirm.payment_id)) !== null,
  );
  if (!stillWaiting) {
    await takeDown();
    await endConfirm(deps, venueId, confirm, "canceled");
    return;
  }
  let answer: ReturnType<typeof inputsAnswerOf> = null;
  try {
    answer = inputsAnswerOf(
      await retrieveReader(deps.stripe, first.account, confirm.stripe_reader_id),
    );
  } catch (e) {
    if (!(e instanceof StripeError || e instanceof StripeUnknownResult)) throw e;
  }
  const now = deps.clock.now();
  const mine = answer?.step === stepOf(confirm.id);
  if (!mine || answer!.status === "in_progress") {
    if (now.epochMilliseconds - Date.parse(confirm.asked_at) < CONFIRM_SCREEN_S * 1000) return;
    await takeDown();
    await endConfirm(deps, venueId, confirm, "timed_out");
    return;
  }
  if (answer!.status === "failed" || answer!.value !== "yes") {
    const state = answer!.failureCode === "terminal_reader_timeout" ? "timed_out" : "no";
    await endConfirm(deps, venueId, confirm, state);
    return;
  }
  // Yes: the guest's go-ahead, then the charge runs here and now (and in the job if this can't).
  const attemptNo = await withVenue(
    deps.pool,
    { venueId, requestId: `tab-confirm:${confirmId}` },
    async (c) => {
      const locked = (await confirmById(c, venueId, confirmId, true))!;
      if (locked.state !== "asking") return null;
      await c.query(
        "update tab_card_confirms set state = 'yes', answered_at = $3 where venue_id = $1 and id = $2",
        [venueId, confirmId, now.toString()],
      );
      const w = await waitingOnFile(c, venueId, locked.payment_id);
      if (!w) return null;
      const n = await goAhead(c, venueId, w, now);
      await emitEvent(c, { venueId, type: "tab.updated", entityId: locked.tab_id });
      return n;
    },
  );
  if (attemptNo !== null)
    await chargeNow(
      { ...deps, payAppUrl: deps.payAppUrl ?? null, texts: deps.texts ?? { allowList: null } },
      venueId,
      confirm.payment_id,
      attemptNo,
    );
}

/** The reader's question for a payment, if one is still on it: read it now (check-status). */
export async function checkSavedCardOfPayment(
  deps: ChargeDeps,
  venueId: string,
  paymentId: string,
) {
  const confirm = await withVenue(
    deps.pool,
    { venueId, requestId: `payment:${paymentId}:confirm` },
    (c) => confirmOfPayment(c, venueId, paymentId),
  );
  if (confirm?.state === "asking") await checkSavedCard(deps, venueId, confirm.id);
}

/** Staff cancel a waiting saved-card charge: the reader's question comes down first. */
export async function takeDownQuestion(deps: PaymentDeps, venueId: string, paymentId: string) {
  const found = await withVenue(
    deps.pool,
    { venueId, requestId: `payment:${paymentId}:confirm` },
    async (c) => ({
      confirm: await confirmOfPayment(c, venueId, paymentId),
      account: await stripeAccountOf(c, venueId),
    }),
  );
  const confirm = found.confirm;
  if (!confirm || confirm.state !== "asking" || !found.account) return;
  await cancelReaderAction(
    deps.stripe,
    found.account,
    confirm.stripe_reader_id,
    `${stepOf(confirm.id)}:cancel_action`,
  ).catch(() => undefined);
  await withVenue(deps.pool, { venueId, requestId: `payment:${paymentId}:confirm` }, async (c) => {
    await c.query(
      `update tab_card_confirms set state = 'canceled', answered_at = $3
          where venue_id = $1 and id = $2 and state = 'asking'`,
      [venueId, confirm.id, deps.clock.now().toString()],
    );
  });
}

/** The confirm job: reads the reader every 2 seconds while it asks, then stops. */
export async function confirmCheckJob(
  deps: ChargeDeps,
  venueId: string,
  payload: { confirm_id: string; n: number },
) {
  await checkSavedCard(deps, venueId, payload.confirm_id);
  await withVenue(
    deps.pool,
    { venueId, requestId: `tab-confirm:${payload.confirm_id}:job` },
    async (c) => {
      const confirm = await confirmById(c, venueId, payload.confirm_id);
      if (confirm?.state === "asking")
        await enqueueConfirmCheck(
          c,
          venueId,
          confirm.id,
          deps.clock.now().add({ seconds: POLL_S }),
          payload.n + 1,
        );
    },
  );
}

/** The webhook's step tag (`confirm:<id>`), if a reader event is about a saved-card question. */
export function confirmOfStep(step: string | null | undefined): string | null {
  const m = /^confirm:([0-9a-f-]{36})$/.exec(step ?? "");
  return m ? m[1]! : null;
}
