import {
  abandonPlanSubscribeAttempt,
  emitEvent,
  enqueue,
  finishPlanSubscribeAttempt,
  insertVenueSubscription,
  planAttempt,
  setModuleAllowed,
  setModuleState,
  statesOf,
  setPlanItems,
  venueModules,
  venueSubscription,
  type JobHandler,
  type PlanId,
  type Queryable,
} from "@west4/db";
import {
  PLAN_GOVERNED_MODULES,
  PLAN_MODULES,
  Temporal,
  missingNeeds,
  planSwitchesOn,
  type ModuleId,
  type ModuleState,
} from "@west4/shared";
import { kitchenNeeds, menusFollowKitchen } from "../kitchen/module.js";
import type { StripeClient } from "../stripe/client.js";
import {
  PLANS_WITH_ROOMS,
  planOfSubscription,
  readCheckoutSession,
  readSubscription,
} from "../stripe/billing.js";
import type { StripeEventHandler } from "../stripe/webhooks.js";

/**
 * Start plan through Stripe Checkout (O-04; spec 17 · Step details 2; D114).
 * The session's outcome is applied the same way whichever way it arrives:
 * `checkout.session.completed` on the Our billing endpoint, or the
 * reconciler's look at a session left open (the `billing.checkout` job,
 * queued with the session for just after it expires). Both read the session
 * and its subscription again from Stripe, outside any transaction, then
 * write `venue_subscriptions` and the plan's module allow-list in one.
 */
export const PLAN_CHECKOUT_KIND = "billing.checkout";
/** How long after the session's expiry the reconciler looks at it. */
const RECONCILE_AFTER_S = 5 * 60;

type InVenue = <T>(work: (c: Queryable) => Promise<T>) => Promise<T>;

/**
 * The Console's allow-list from the plan: the plan's modules allowed, the
 * other plan modules not. A module the venue has on stays allowed until it's
 * turned off in Admin → Features, so nothing disappears mid-service (as the
 * Console's own switch, M1-35). Modules no plan names are never touched.
 *
 * Then the plan switches on what it newly includes (D121): every module of a
 * first plan, or the ones a changed plan adds. A module whose needs aren't met
 * yet (Bar tabs before the go-live merchant category, Kitchen & food before
 * its printer and allergy notice) stays off, and Admin → Features says why.
 * The same plan again switches nothing on, so the owner's off stays off.
 */
export async function allowPlanModules(
  c: Queryable,
  venueId: string,
  plan: PlanId,
  switchOn: { readonly from: PlanId | null; readonly now: Temporal.Instant } | null = null,
): Promise<boolean> {
  const rows = await venueModules(c, venueId);
  let changed = false;
  for (const id of PLAN_GOVERNED_MODULES) {
    const row = rows.find((r) => r.module_id === id);
    const want = PLAN_MODULES[plan].includes(id);
    if (!row || row.allowed === want) continue;
    if (!want && row.state !== "off") continue;
    await setModuleAllowed(c, venueId, id, want, undefined);
    changed = true;
  }
  if (switchOn) {
    const states: Partial<Record<ModuleId, ModuleState>> = {
      ...statesOf(await venueModules(c, venueId)),
    };
    for (const id of planSwitchesOn(plan, switchOn.from)) {
      if (states[id] === "on" || missingNeeds(states, id).length > 0) continue;
      if (id === "kitchen") {
        const clock = { now: () => switchOn.now };
        if ((await kitchenNeeds(c, venueId, clock)).length > 0) continue;
        await setModuleState(c, venueId, id, "on", undefined);
        await menusFollowKitchen(c, venueId, switchOn.now);
      } else await setModuleState(c, venueId, id, "on", undefined);
      states[id] = "on";
      changed = true;
    }
  }
  if (changed)
    await emitEvent(c, {
      venueId,
      type: "settings.changed",
      entityId: "modules",
      entityVersion: 0,
    });
  return changed;
}

/** Queue the reconciler's look at a new session, in the transaction that records it. */
export async function queueCheckoutReconcile(
  c: Queryable,
  venueId: string,
  attemptId: string,
  expiresAtS: number,
): Promise<void> {
  await enqueue(c, {
    venueId,
    kind: PLAN_CHECKOUT_KIND,
    pool: "normal",
    dedupeKey: `${PLAN_CHECKOUT_KIND}:${attemptId}`,
    payload: { attempt_id: attemptId },
    runAt: Temporal.Instant.fromEpochMilliseconds((expiresAtS + RECONCILE_AFTER_S) * 1000),
    maxAttempts: 10,
  });
}

export type CheckoutOutcome = "started" | "already" | "expired" | "open" | "unknown";

/**
 * Apply what Stripe says about one attempt's session. A completed session's
 * subscription becomes the venue's plan; an expired one ends the attempt, so
 * the next Start plan has a new key; an open one changes nothing.
 */
export async function applyCheckout(
  inVenue: InVenue,
  stripe: StripeClient,
  venueId: string,
  by: { sessionId: string } | { id: string },
  now: Temporal.Instant,
): Promise<CheckoutOutcome> {
  const attempt = await inVenue((c) => planAttempt(c, venueId, by));
  if (!attempt?.checkout_session_id) return "unknown";
  if (attempt.finished) return attempt.stripe_subscription_id ? "already" : "expired";
  const session = await readCheckoutSession(stripe, attempt.checkout_session_id);
  if (session.status === "expired") {
    await inVenue((c) => abandonPlanSubscribeAttempt(c, attempt.id));
    return "expired";
  }
  if (session.status !== "complete" || !session.subscription) return "open";
  const sub = await readSubscription(stripe, session.subscription);
  // What Stripe made is the plan, whatever the attempt asked for (the founder's Prices decide).
  const made = planOfSubscription(sub);
  const plan = made?.plan ?? attempt.plan;
  return inVenue(async (c) => {
    const existing = await venueSubscription(c, venueId, { lock: true });
    if (existing?.stripe_subscription_id === sub.id) {
      await finishPlanSubscribeAttempt(c, attempt.id, sub.id);
      return "already";
    }
    await insertVenueSubscription(c, {
      venueId,
      plan,
      subscriptionId: sub.id,
      roomItemId: made?.roomItem?.id ?? null,
      roomQuantity: PLANS_WITH_ROOMS.includes(plan) ? (made?.roomItem?.quantity ?? 0) : 0,
      status: sub.status,
    });
    await finishPlanSubscribeAttempt(c, attempt.id, sub.id);
    await allowPlanModules(c, venueId, plan, { from: existing?.plan ?? null, now });
    await emitEvent(c, { venueId, type: "plan.updated", entityId: venueId });
    return "started";
  });
}

/** A change made in Stripe's portal: the plan and the room item follow the subscription's Prices. */
export async function followPlanItems(
  c: Queryable,
  venueId: string,
  sub: Parameters<typeof planOfSubscription>[0],
  now: Temporal.Instant,
): Promise<boolean> {
  const made = planOfSubscription(sub);
  if (!made) return false;
  const before = await venueSubscription(c, venueId);
  const moved = await setPlanItems(c, venueId, {
    plan: made.plan,
    roomItemId: made.roomItem?.id ?? null,
    roomQuantity: made.roomItem?.quantity ?? 0,
  });
  const allowed = await allowPlanModules(c, venueId, made.plan, {
    from: before?.plan ?? null,
    now,
  });
  return moved || allowed;
}

const onCheckoutCompleted: StripeEventHandler = async (ctx) => {
  if (ctx.event.endpoint !== "platform") return;
  const object = (ctx.event.payload as { data?: { object?: { id?: unknown } } }).data?.object;
  if (typeof object?.id !== "string") return;
  await applyCheckout(ctx.inVenue, ctx.stripe, ctx.venueId, { sessionId: object.id }, ctx.now);
};

export const checkoutEventHandlers: readonly [string, StripeEventHandler][] = [
  ["checkout.session.completed", onCheckoutCompleted],
];

/** The reconciler's look at a session left open: applied, ended, or looked at again later. */
export function makePlanCheckoutHandler(stripe: StripeClient): JobHandler {
  return async (job) => {
    const venueId = job.job.venue_id;
    const attemptId = (job.job.payload as { attempt_id?: unknown }).attempt_id;
    if (typeof attemptId !== "string") return;
    const inVenue: InVenue = (work) => job.step(work);
    const outcome = await applyCheckout(
      inVenue,
      stripe,
      venueId,
      { id: attemptId },
      job.clock.now(),
    );
    if (outcome !== "open") return;
    // Still open past its expiry (Stripe's clock and ours disagree): look again in half an hour.
    const next = job.clock.now().add({ minutes: 30 });
    await job.step((c) =>
      enqueue(c, {
        venueId,
        kind: PLAN_CHECKOUT_KIND,
        pool: "normal",
        payload: { attempt_id: attemptId },
        runAt: next,
        maxAttempts: 10,
      }),
    );
  };
}
