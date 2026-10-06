import type pg from "pg";
import {
  allocate,
  amountDue,
  complete,
  enqueue,
  fail,
  insertPayment,
  latestAttempt,
  paymentById,
  readerOfVenue,
  setPaymentIntent,
  startAttempt,
  stripeAccountOf,
  withVenue,
  type AttemptRow,
  type JobHandler,
  type PaymentRow,
  type PaymentSource,
  type Queryable,
} from "@west4/db";
import { Temporal, type Clock } from "@west4/shared";
import { StripeError, StripeUnknownResult, type StripeClient } from "../stripe/client.js";
import {
  cancelIntent,
  cancelReaderAction,
  createOffSessionIntent,
  createReaderIntent,
  observeIntent,
  processOnReader,
  retrieveIntent,
  savedCardOf,
  type ReaderAction,
} from "../stripe/payments.js";
import { retrieveReader } from "../stripe/terminal.js";
import { applyObservation, type Applied, type Observation } from "./machine.js";
import { claimShare } from "./splits.js";
import { openAttempt } from "./state.js";
import {
  ON_FILE_DECLINED_KIND,
  enqueueDeclined,
  followUpDecline,
  savedCardFor,
} from "./card-on-file.js";
import type { VenueTextSettings } from "../texts/venue.js";
import { REFUND_RUN_KIND, runRefund } from "./refunds.js";
import { confirmCollected, surchargeFor } from "./surcharge.js";
import { collectOnReader } from "../stripe/surcharge.js";
import {
  collectForTab,
  createTabCustomer,
  createTabIntent,
  captureHold,
  incrementHold,
} from "../stripe/tabs.js";
import { TAB_CLOSE_CHECK_KIND, closeCheckJob } from "../tabs/close.js";
import { TAB_RELEASE_KIND, openingOfPayment } from "../tabs/open.js";

/**
 * How every card payment runs (M4-05; Payment flows steps 1 to 4):
 *  1. one short transaction writes the payment, its attempt, an in-progress
 *     allocation and a `payment.run` job, and commits;
 *  2. the job calls Stripe outside any transaction with the attempt's key
 *     (the API runs it at once; the worker picks it up if the API dies);
 *  3. a second short transaction records the result through the state machine.
 * Then `payment.check` reads the PaymentIntent and the reader every 2 seconds:
 * a reader action still running after 20 seconds, or no clear answer from
 * Stripe, makes the attempt unknown ("Checking with Stripe · don't retry");
 * after 2 minutes unknown, the PaymentIntent is canceled (and cancel_action
 * sent to the reader), unless the cancel finds it went through.
 */
export const PAYMENT_RUN_KIND = "payment.run";
export const PAYMENT_CHECK_KIND = "payment.check";
export const POLL_EVERY_S = 2;
export const UNKNOWN_AFTER_S = 20;
export const GIVE_UP_AFTER_S = 120;

export interface PaymentDeps {
  readonly pool: pg.Pool;
  readonly stripe: StripeClient;
  readonly clock: Clock;
  /** For the pay link texted after a declined card on file (M4-17); the worker sets them. */
  readonly payAppUrl?: string | null;
  readonly texts?: Pick<VenueTextSettings, "allowList">;
}

type InVenue = <T>(work: (c: Queryable) => Promise<T>) => Promise<T>;
const venueTx =
  (deps: PaymentDeps, venueId: string, requestId: string): InVenue =>
  (work) =>
    withVenue(deps.pool, { venueId, requestId }, work);

/** The reader isn't ours (404, nothing sent to Stripe). */
export class NoSuchReader extends Error {}
/** No heartbeat from the reader for 2 minutes (503 reader_offline, nothing sent to Stripe). */
export class ReaderQuiet extends Error {}

export async function quiet(
  c: Queryable,
  venueId: string,
  deviceId: string,
  now: Temporal.Instant,
): Promise<boolean> {
  const r = await c.query<{ quiet: boolean }>(
    `select (offline_since is not null or last_seen_at < $3::timestamptz - interval '2 minutes') as quiet
       from device_heartbeats where venue_id = $1 and device_id = $2`,
    [venueId, deviceId, now.toString()],
  );
  return r.rows[0]?.quiet ?? false;
}

/** Step 1 for a tap: inside the caller's transaction. */
export async function writeTap(
  c: Queryable,
  venueId: string,
  input: {
    checkId: string;
    amountCents: number;
    readerDeviceId: string;
    shareId?: string | null;
    /** "Additional tip (optional)": the reader charges it on top; it's the guest's, never allocated. */
    tipCents?: number;
    businessDate: string;
    training?: boolean;
    now: Temporal.Instant;
  },
): Promise<{ paymentId: string; attemptNo: number }> {
  const reader = await readerOfVenue(c, venueId, input.readerDeviceId);
  if (!reader) throw new NoSuchReader();
  if (await quiet(c, venueId, input.readerDeviceId, input.now)) throw new ReaderQuiet();
  // A split's share (M4-14): this check's, open, and paid in its own amount.
  const claimed = input.shareId
    ? await claimShare(c, venueId, input.checkId, input.shareId, input.amountCents, "paying")
    : null;
  const paymentId = await insertPayment(c, venueId, {
    method: "card_present",
    status: "pending",
    businessDate: input.businessDate,
    tipCents: input.tipCents ?? 0,
    training: input.training ?? false,
  });
  await allocate(c, venueId, {
    paymentId,
    checkId: input.checkId,
    amountCents: input.amountCents,
    state: "in_progress",
    shareId: input.shareId ?? null,
    leaveOut: claimed?.leaveOut ?? null,
  });
  const { attemptNo } = await startAttempt(c, venueId, {
    paymentId,
    checkId: input.checkId,
    portionKey: input.shareId ? `share:${input.shareId}` : "full",
    action: "process",
    readerId: reader.stripe_reader_id,
    amountCents: input.amountCents + (input.tipCents ?? 0),
    startedAt: input.now.toString(),
  });
  await enqueueRun(c, venueId, paymentId, attemptNo, input.now);
  return { paymentId, attemptNo };
}

/** Another tap on the same payment: a new attempt with a new key on the same PaymentIntent. */
export async function writeRetap(
  c: Queryable,
  venueId: string,
  input: { paymentId: string; readerDeviceId: string; now: Temporal.Instant },
): Promise<{ attemptNo: number }> {
  const reader = await readerOfVenue(c, venueId, input.readerDeviceId);
  if (!reader) throw new NoSuchReader();
  if (await quiet(c, venueId, input.readerDeviceId, input.now)) throw new ReaderQuiet();
  const payment = await paymentById(c, venueId, input.paymentId, true);
  const last = await latestAttempt(c, venueId, input.paymentId);
  if (!payment || !last || payment.method !== "card_present")
    throw new Error("no card payment to tap again");
  if (payment.status !== "pending") throw new Error(`this payment is ${payment.status}`);
  const { attemptNo } = await startAttempt(c, venueId, {
    paymentId: input.paymentId,
    checkId: last.check_id,
    portionKey: last.portion_key,
    action: "process",
    readerId: reader.stripe_reader_id,
    amountCents: last.amount_cents,
    startedAt: input.now.toString(),
  });
  await enqueueRun(c, venueId, input.paymentId, attemptNo, input.now);
  return { attemptNo };
}

export async function enqueueRun(
  c: Queryable,
  venueId: string,
  paymentId: string,
  attemptNo: number,
  now: Temporal.Instant,
) {
  await enqueue(c, {
    venueId,
    kind: PAYMENT_RUN_KIND,
    pool: "critical",
    dedupeKey: `${PAYMENT_RUN_KIND}:${paymentId}:${attemptNo}`,
    payload: { payment_id: paymentId, attempt_no: attemptNo },
    runAt: now,
    maxAttempts: 3,
  });
}

async function enqueueCheck(
  c: Queryable,
  venueId: string,
  paymentId: string,
  attemptNo: number,
  at: Temporal.Instant,
  n: number,
  unknownSince: string | null,
) {
  await enqueue(c, {
    venueId,
    kind: PAYMENT_CHECK_KIND,
    pool: "critical",
    dedupeKey: `${PAYMENT_CHECK_KIND}:${paymentId}:${attemptNo}:${n}`,
    payload: { payment_id: paymentId, attempt_no: attemptNo, n, unknown_since: unknownSince },
    runAt: at,
    maxAttempts: 3,
  });
}

interface Context {
  readonly payment: PaymentRow;
  readonly attempt: AttemptRow | null;
  readonly account: string | null;
  readonly skipTipping: boolean;
  /** A bar or quick sale's drinks before tax, which the reader's tip choices work on (M6-05). */
  readonly amountEligibleCents: number | null;
  /** The card fee at the reader is on (M4-25): collect first, then confirm. */
  readonly collect: boolean;
  /** A bar tab's opening hold (M6-06): collect first, check the card, then confirm. */
  readonly tab: boolean;
}

async function context(
  inVenue: InVenue,
  venueId: string,
  paymentId: string,
): Promise<Context | null> {
  return inVenue(async (c) => {
    const payment = await paymentById(c, venueId, paymentId);
    if (!payment) return null;
    const attempt = await latestAttempt(c, venueId, paymentId);
    const kind = attempt?.check_id
      ? (
          await c.query<{ kind: string }>(
            "select kind from checks where venue_id = $1 and id = $2",
            [venueId, attempt.check_id],
          )
        ).rows[0]?.kind
      : null;
    const drinks =
      attempt?.check_id && kind && kind !== "room"
        ? (
            await c.query<{ cents: number }>(
              `select coalesce(sum(amount_cents), 0)::int as cents from check_lines
                where venue_id = $1 and check_id = $2 and kind in ('item', 'comp', 'void', 'discount')`,
              [venueId, attempt.check_id],
            )
          ).rows[0]!.cents
        : null;
    return {
      payment,
      attempt,
      account: await stripeAccountOf(c, venueId),
      skipTipping: kind === "room",
      // A share of a split tips on no more than its own amount.
      amountEligibleCents:
        drinks !== null && drinks > 0 ? Math.min(drinks, attempt!.amount_cents) : null,
      collect: (await surchargeFor(c, venueId, payment.business_date)) !== null,
      tab: (await openingOfPayment(c, venueId, paymentId)) !== null,
    };
  });
}

/** Step 2 and 3 of one attempt: the `payment.run` job. Returns what was recorded. */
export async function runAttempt(
  deps: PaymentDeps,
  venueId: string,
  paymentId: string,
  attemptNo: number,
): Promise<Applied | null> {
  const inVenue = venueTx(deps, venueId, `payment:${paymentId}:${attemptNo}`);
  const ctx = await context(inVenue, venueId, paymentId);
  if (!ctx || !ctx.account || !ctx.attempt || ctx.attempt.attempt_no !== attemptNo) return null;
  if (ctx.attempt.state !== "started") return null;
  const { payment, attempt, account } = ctx;
  const record = (obs: Observation) =>
    inVenue((c) => applyObservation(c, venueId, paymentId, obs, "api", null, deps.clock.now()));
  const now = deps.clock.now();
  if (attempt.action === "off_session") {
    // Card on file (M4-17): one call creates and confirms the charge on the deposit's saved card.
    const card = attempt.check_id
      ? await inVenue((c) => savedCardFor(c, venueId, attempt.check_id!))
      : null;
    try {
      const saved = card ? await savedCardOf(deps.stripe, account, card.deposit_pi_id) : null;
      if (!saved) return record({ attempt: { state: "failed", code: "no_saved_card" } });
      const pi = await createOffSessionIntent(
        deps.stripe,
        account,
        {
          amountCents: attempt.amount_cents,
          paymentId,
          checkId: attempt.check_id,
          customer: saved.customer,
          paymentMethod: saved.paymentMethod,
        },
        attempt.idem_key,
      );
      await inVenue((c) => setPaymentIntent(c, paymentId, pi.id));
      const applied = await record({ intent: observeIntent(pi) });
      // A bank asking the cardholder to authenticate can't be answered off-session: treat it as a decline.
      if (pi.status !== "succeeded")
        await inVenue((c) => enqueueDeclined(c, venueId, paymentId, now));
      return applied;
    } catch (e) {
      if (e instanceof StripeError) {
        const piId = e.paymentIntentId;
        if (piId) await inVenue((c) => setPaymentIntent(c, paymentId, piId));
        const applied = await record({
          attempt: { state: "failed", code: e.declineCode ?? e.code ?? e.type },
        });
        await inVenue((c) => enqueueDeclined(c, venueId, paymentId, now));
        return applied;
      }
      if (!(e instanceof StripeUnknownResult)) throw e;
      const applied = await record({ attempt: { state: "unknown" } });
      await inVenue((c) =>
        enqueueCheck(
          c,
          venueId,
          paymentId,
          attemptNo,
          now.add({ seconds: POLL_EVERY_S }),
          1,
          now.toString(),
        ),
      );
      return applied;
    }
  }
  if (attempt.action === "increment") {
    // A bar tab's raise (M6-07): one call, keyed with its target; the old hold stays good whatever happens.
    try {
      const pi = await incrementHold(
        deps.stripe,
        account,
        { piId: payment.stripe_pi_id!, targetCents: attempt.amount_cents },
        attempt.idem_key,
      );
      return record({ intent: observeIntent(pi) });
    } catch (e) {
      if (e instanceof StripeError)
        return record({
          attempt: {
            state: "failed",
            code:
              e.code === "card_declined" || e.type === "card_error"
                ? "card_declined"
                : (e.code ?? e.type),
          },
        });
      if (!(e instanceof StripeUnknownResult)) throw e;
      const applied = await record({ attempt: { state: "unknown" } });
      await inVenue((c) =>
        enqueueCheck(
          c,
          venueId,
          paymentId,
          attemptNo,
          now.add({ seconds: POLL_EVERY_S }),
          1,
          now.toString(),
        ),
      );
      return applied;
    }
  }
  if (attempt.action === "capture") {
    // Closing a bar tab (M6-08): the total plus the tip in one call, keyed with the amount.
    try {
      const pi = await captureHold(
        deps.stripe,
        account,
        { piId: payment.stripe_pi_id!, amountCents: attempt.amount_cents },
        attempt.idem_key,
      );
      await deps.stripe.step("after-capture");
      return record({ intent: observeIntent(pi) });
    } catch (e) {
      if (e instanceof StripeError)
        return record({ attempt: { state: "failed", code: e.code ?? e.type } });
      if (!(e instanceof StripeUnknownResult)) throw e;
      const applied = await record({ attempt: { state: "unknown" } });
      await inVenue((c) =>
        enqueueCheck(
          c,
          venueId,
          paymentId,
          attemptNo,
          now.add({ seconds: POLL_EVERY_S }),
          1,
          now.toString(),
        ),
      );
      return applied;
    }
  }
  try {
    let piId = payment.stripe_pi_id;
    if (!piId) {
      const pi = ctx.tab
        ? await createTabIntent(deps.stripe, account, {
            amountCents: attempt.amount_cents,
            paymentId,
            customer: (await createTabCustomer(deps.stripe, account, paymentId)).id,
          })
        : await createReaderIntent(deps.stripe, account, {
            amountCents: attempt.amount_cents,
            paymentId,
            checkId: attempt.check_id,
          });
      piId = pi.id;
      await deps.stripe.step("after-create-intent");
      await inVenue((c) => setPaymentIntent(c, paymentId, pi.id));
    }
    await deps.stripe.step("before-process");
    if (ctx.tab)
      await collectForTab(
        deps.stripe,
        account,
        { readerId: attempt.reader_id!, piId },
        attempt.idem_key,
      );
    else if (ctx.collect)
      await collectOnReader(
        deps.stripe,
        account,
        {
          readerId: attempt.reader_id!,
          piId,
          skipTipping: ctx.skipTipping,
          amountEligibleCents: ctx.amountEligibleCents,
        },
        attempt.idem_key,
      );
    else
      await processOnReader(
        deps.stripe,
        account,
        {
          readerId: attempt.reader_id!,
          piId,
          skipTipping: ctx.skipTipping,
          amountEligibleCents: ctx.amountEligibleCents,
        },
        attempt.idem_key,
      );
    await deps.stripe.step("after-process");
    // The live drill (M4-30): during its hour, our copy of Stripe's answer is dropped on purpose,
    // so the payment goes to "Checking with Stripe" and the poller and reconciler settle it.
    if (await inVenue((c) => drillDropsAnswer(c, venueId, now)))
      throw new StripeUnknownResult("drill: our copy of Stripe's answer was dropped on purpose");
  } catch (e) {
    if (e instanceof StripeUnknownResult) {
      const applied = await record({ attempt: { state: "unknown" } });
      await inVenue((c) =>
        enqueueCheck(
          c,
          venueId,
          paymentId,
          attemptNo,
          now.add({ seconds: POLL_EVERY_S }),
          1,
          now.toString(),
        ),
      );
      return applied;
    }
    if (e instanceof StripeError) {
      const code = e.code ?? e.type;
      if (code === "terminal_reader_timeout") {
        const applied = await record({ attempt: { state: "unknown", code } });
        await inVenue((c) =>
          enqueueCheck(
            c,
            venueId,
            paymentId,
            attemptNo,
            now.add({ seconds: POLL_EVERY_S }),
            1,
            now.toString(),
          ),
        );
        return applied;
      }
      return record({ attempt: { state: "failed", code } });
    }
    throw e;
  }
  await inVenue((c) =>
    enqueueCheck(c, venueId, paymentId, attemptNo, now.add({ seconds: POLL_EVERY_S }), 1, null),
  );
  return inVenue(async (c) => ({
    changed: false,
    payment: (await paymentById(c, venueId, paymentId))!,
    attempt: await latestAttempt(c, venueId, paymentId),
  }));
}

/** Reads the PaymentIntent and the reader's action from Stripe, outside any transaction. */
export async function observe(deps: PaymentDeps, ctx: Context): Promise<Observation> {
  if (!ctx.account || !ctx.payment.stripe_pi_id) return {};
  const intent = observeIntent(
    await retrieveIntent(deps.stripe, ctx.account, ctx.payment.stripe_pi_id),
  );
  let reader: ReaderAction | null = null;
  if (ctx.attempt?.reader_id && openAttempt(ctx.attempt.state)) {
    const r = await retrieveReader(deps.stripe, ctx.account, ctx.attempt.reader_id);
    const action = (r.action ?? null) as ReaderAction | null;
    const on =
      action?.process_payment_intent?.payment_intent ??
      action?.collect_payment_method?.payment_intent ??
      action?.confirm_payment_intent?.payment_intent;
    if (on === ctx.payment.stripe_pi_id) reader = action;
  }
  return { intent, reader };
}

/** check-status, a webhook, the reconciler: read Stripe now and record it. */
export async function checkNow(
  deps: PaymentDeps,
  venueId: string,
  paymentId: string,
  source: PaymentSource,
  stripeEventId: string | null = null,
): Promise<Applied | null> {
  const inVenue = venueTx(deps, venueId, `payment:${paymentId}:check`);
  const ctx = await context(inVenue, venueId, paymentId);
  if (!ctx) return null;
  let obs: Observation;
  try {
    obs = await observe(deps, ctx);
  } catch (e) {
    if (e instanceof StripeUnknownResult || e instanceof StripeError) obs = {};
    else throw e;
  }
  return inVenue((c) =>
    applyObservation(c, venueId, paymentId, obs, source, stripeEventId, deps.clock.now()),
  );
}

/**
 * Cancels a payment that hasn't gone through: cancel_action to the reader (which can fail while it's
 * offline) and the PaymentIntent's cancel, which is enough on its own. A cancel that finds the payment
 * went through records the success instead.
 */
export async function cancelPayment(
  deps: PaymentDeps,
  venueId: string,
  paymentId: string,
  source: PaymentSource,
) {
  const inVenue = venueTx(deps, venueId, `payment:${paymentId}:cancel`);
  const ctx = await context(inVenue, venueId, paymentId);
  if (!ctx) return null;
  const { payment, attempt, account } = ctx;
  // A tab's raise (M6-07) never cancels the hold it was growing: read Stripe once more, and a raise
  // still unclear ends as not raised, with the old hold standing.
  // A tab's capture (M6-08) never cancels the hold either: still unclear after the read, it wasn't
  // captured, and the tab waits for a manager; it's never sent again.
  if (attempt?.action === "increment" || attempt?.action === "capture") {
    if (!openAttempt(attempt.state)) return { changed: false, payment, attempt };
    const read = await checkNow(deps, venueId, paymentId, source);
    if (read?.attempt && openAttempt(read.attempt.state))
      return inVenue((c) =>
        applyObservation(
          c,
          venueId,
          paymentId,
          {
            attempt: {
              state: "canceled",
              code: attempt.action === "capture" ? "not_captured" : "not_raised",
            },
          },
          source,
          null,
          deps.clock.now(),
        ),
      );
    return read;
  }
  if (["captured", "partly_refunded", "refunded", "canceled", "failed"].includes(payment.status))
    return { changed: false, payment, attempt };
  if (account && attempt?.reader_id && openAttempt(attempt.state))
    await cancelReaderAction(
      deps.stripe,
      account,
      attempt.reader_id,
      `${paymentId}:cancel_action:${attempt.attempt_no}`,
    ).catch(() => undefined);
  if (account && payment.stripe_pi_id) {
    try {
      const pi = await cancelIntent(
        deps.stripe,
        account,
        payment.stripe_pi_id,
        `${paymentId}:cancel`,
      );
      return inVenue((c) =>
        applyObservation(
          c,
          venueId,
          paymentId,
          { intent: observeIntent(pi) },
          source,
          null,
          deps.clock.now(),
        ),
      );
    } catch (e) {
      if (!(e instanceof StripeError)) throw e;
      // It may have gone through: read it and record what's true.
      return checkNow(deps, venueId, paymentId, source);
    }
  }
  // No PaymentIntent was ever made: nothing at Stripe to cancel.
  return inVenue((c) =>
    applyObservation(
      c,
      venueId,
      paymentId,
      {
        intent: {
          id: "",
          status: "canceled",
          amountReceived: 0,
          amountCapturable: 0,
          tipCents: 0,
          surchargeCents: 0,
          declineCode: null,
          errorCode: null,
          card: null,
          hold: null,
        },
      },
      source,
    ),
  );
}

/** The `payment.check` job: poll every 2 seconds; unknown after 20; give up after 2 minutes unknown. */
export async function pollAttempt(
  deps: PaymentDeps,
  venueId: string,
  payload: { payment_id: string; attempt_no: number; n: number; unknown_since: string | null },
): Promise<void> {
  // The surcharge path (M4-25): a collected card is confirmed here if its webhook is late.
  await confirmCollected(deps, venueId, payload.payment_id).catch(() => undefined);
  const applied = await checkNow(deps, venueId, payload.payment_id, "api");
  if (!applied?.attempt || applied.attempt.attempt_no !== payload.attempt_no) return;
  const { attempt, payment } = applied;
  // A tab's raise (M6-07) polls on a hold that's already placed.
  const raising =
    (attempt.action === "increment" || attempt.action === "capture") &&
    payment.status === "authorized";
  if (!openAttempt(attempt.state) || (payment.status !== "pending" && !raising)) return;
  const inVenue = venueTx(deps, venueId, `payment:${payment.id}:poll`);
  const now = deps.clock.now();
  let unknownSince = payload.unknown_since;
  if (attempt.state === "started") {
    const running = now.epochMilliseconds - Date.parse(attempt.started_at);
    if (running >= UNKNOWN_AFTER_S * 1000) {
      await inVenue((c) =>
        applyObservation(c, venueId, payment.id, { attempt: { state: "unknown" } }, "api"),
      );
      unknownSince = now.toString();
    }
  } else if (!unknownSince) unknownSince = now.toString();
  if (unknownSince && now.epochMilliseconds - Date.parse(unknownSince) >= GIVE_UP_AFTER_S * 1000) {
    await cancelPayment(deps, venueId, payment.id, "api");
    return;
  }
  await inVenue((c) =>
    enqueueCheck(
      c,
      venueId,
      payment.id,
      payload.attempt_no,
      now.add({ seconds: POLL_EVERY_S }),
      payload.n + 1,
      unknownSince,
    ),
  );
}

export function makePaymentHandlers(deps: PaymentDeps): Record<string, JobHandler> {
  return {
    [PAYMENT_RUN_KIND]: async (job) => {
      const p = job.job.payload as { payment_id: string; attempt_no: number };
      await runAttempt(deps, job.job.venue_id, p.payment_id, p.attempt_no);
    },
    [PAYMENT_CHECK_KIND]: async (job) => {
      await pollAttempt(deps, job.job.venue_id, job.job.payload as never);
    },
    // An approved card refund (M4-21): sent to Stripe once, keyed <payment_id>:refund:<n>.
    [REFUND_RUN_KIND]: async (job) => {
      const p = job.job.payload as { refund_id: string };
      await runRefund(deps, job.job.venue_id, p.refund_id);
    },
    // A bar tab's new hold on a card that already had an open tab (M6-06): released at once.
    [TAB_RELEASE_KIND]: async (job) => {
      const p = job.job.payload as { payment_id: string };
      await cancelPayment(deps, job.job.venue_id, p.payment_id, "api");
    },
    // Closing a bar tab (M6-08): the reader's tip screen, read every 2 seconds while it asks.
    [TAB_CLOSE_CHECK_KIND]: async (job) => {
      await closeCheckJob(deps, job.job.venue_id, job.job.payload as never);
    },
    // A declined card on file (M4-17): cancel it, and text the guest a pay link for the balance.
    [ON_FILE_DECLINED_KIND]: async (job) => {
      const p = job.job.payload as { payment_id: string };
      await followUpDecline(
        { ...deps, payAppUrl: deps.payAppUrl ?? null, texts: deps.texts ?? { allowList: null } },
        job.job.venue_id,
        p.payment_id,
      );
    },
  };
}

/** The amount still due, for the screens. */
export const dueOf = (c: Queryable, checkId: string): Promise<number> => amountDue(c, checkId);

/**
 * Runs an attempt's `payment.run` job here and now, so the screen hears at once. It claims the job
 * like a worker would (with a lease), so if this process dies the worker runs it after the lease.
 */
export async function runNow(
  deps: PaymentDeps,
  venueId: string,
  paymentId: string,
  attemptNo: number,
): Promise<Applied | null> {
  return claimAndRun(deps, venueId, `${PAYMENT_RUN_KIND}:${paymentId}:${attemptNo}`, () =>
    runAttempt(deps, venueId, paymentId, attemptNo),
  );
}

/** Claims a queued job by its dedupe key (with a lease, as a worker would) and runs it here and now. */
export async function claimAndRun<T>(
  deps: PaymentDeps,
  venueId: string,
  dedupeKey: string,
  work: () => Promise<T>,
): Promise<T | null> {
  const inVenue = venueTx(deps, venueId, `job:${dedupeKey}:now`);
  const now = deps.clock.now();
  const claimed = await inVenue((c) =>
    c.query<{ id: string; attempts: number; max_attempts: number }>(
      `update jobs set status = 'running', attempts = attempts + 1, locked_until = $3
        where venue_id = $1 and dedupe_key = $2 and status = 'queued'
        returning id, attempts, max_attempts`,
      [venueId, dedupeKey, new Date(now.add({ seconds: 60 }).epochMilliseconds)],
    ),
  );
  const job = claimed.rows[0];
  if (!job) return null;
  try {
    const done = await work();
    await inVenue((c) => complete(c, job.id, deps.clock.now()));
    return done;
  } catch (e) {
    await inVenue((c) =>
      fail(c, job, e instanceof Error ? e.message : String(e), deps.clock.now()),
    );
    throw e;
  }
}

/** Whether the live drill's flag is on for this venue now (M4-30): never past its end. */
async function drillDropsAnswer(c: Queryable, venueId: string, now: Temporal.Instant) {
  const r = await c.query<{ until: string | null }>(
    "select to_json(drill_drop_until) #>> '{}' as until from venues where id = $1",
    [venueId],
  );
  const until = r.rows[0]?.until;
  return !!until && Temporal.Instant.compare(now, Temporal.Instant.from(until)) < 0;
}
