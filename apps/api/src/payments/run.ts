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
import type { Clock, Temporal } from "@west4/shared";
import { StripeError, StripeUnknownResult, type StripeClient } from "../stripe/client.js";
import {
  cancelIntent,
  cancelReaderAction,
  createReaderIntent,
  observeIntent,
  processOnReader,
  retrieveIntent,
  type ReaderAction,
} from "../stripe/payments.js";
import { retrieveReader } from "../stripe/terminal.js";
import { applyObservation, type Applied, type Observation } from "./machine.js";
import { claimShare } from "./splits.js";
import { openAttempt } from "./state.js";

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

async function quiet(
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
  if (input.shareId)
    await claimShare(c, venueId, input.checkId, input.shareId, input.amountCents, "paying");
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

async function enqueueRun(
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
    return {
      payment,
      attempt,
      account: await stripeAccountOf(c, venueId),
      skipTipping: kind === "room",
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
  try {
    let piId = payment.stripe_pi_id;
    if (!piId) {
      const pi = await createReaderIntent(deps.stripe, account, {
        amountCents: attempt.amount_cents,
        paymentId,
        checkId: attempt.check_id,
      });
      piId = pi.id;
      await deps.stripe.step("after-create-intent");
      await inVenue((c) => setPaymentIntent(c, paymentId, pi.id));
    }
    await deps.stripe.step("before-process");
    await processOnReader(
      deps.stripe,
      account,
      { readerId: attempt.reader_id!, piId, skipTipping: ctx.skipTipping },
      attempt.idem_key,
    );
    await deps.stripe.step("after-process");
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
    if (action?.process_payment_intent?.payment_intent === ctx.payment.stripe_pi_id)
      reader = action;
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
          declineCode: null,
          errorCode: null,
          card: null,
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
  const applied = await checkNow(deps, venueId, payload.payment_id, "api");
  if (!applied?.attempt || applied.attempt.attempt_no !== payload.attempt_no) return;
  const { attempt, payment } = applied;
  if (!openAttempt(attempt.state) || payment.status !== "pending") return;
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
  const inVenue = venueTx(deps, venueId, `payment:${paymentId}:${attemptNo}:now`);
  const now = deps.clock.now();
  const claimed = await inVenue((c) =>
    c.query<{ id: string; attempts: number; max_attempts: number }>(
      `update jobs set status = 'running', attempts = attempts + 1, locked_until = $3
        where venue_id = $1 and dedupe_key = $2 and status = 'queued'
        returning id, attempts, max_attempts`,
      [
        venueId,
        `${PAYMENT_RUN_KIND}:${paymentId}:${attemptNo}`,
        new Date(now.add({ seconds: 60 }).epochMilliseconds),
      ],
    ),
  );
  const job = claimed.rows[0];
  if (!job) return null;
  try {
    const applied = await runAttempt(deps, venueId, paymentId, attemptNo);
    await inVenue((c) => complete(c, job.id, deps.clock.now()));
    return applied;
  } catch (e) {
    await inVenue((c) =>
      fail(c, job, e instanceof Error ? e.message : String(e), deps.clock.now()),
    );
    throw e;
  }
}
