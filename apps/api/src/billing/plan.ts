import type pg from "pg";
import {
  billableRooms,
  emitEvent,
  enqueue,
  insertVenueSubscription,
  setPlanStatus,
  setRoomQuantity,
  venueSubscription,
  withVenue,
  type JobHandler,
  type PlanId,
  type Queryable,
} from "@west4/db";
import type { Temporal } from "@west4/shared";
import type { StripeClient } from "../stripe/client.js";
import {
  createCustomer,
  createSubscription,
  invoiceSubscription,
  planPrices,
  readInvoice,
  readSubscription,
  setRoomItemQuantity,
  PLANS_WITH_ROOMS,
  type StripeSubscription,
} from "../stripe/billing.js";
import type { StripeEventContext, StripeEventHandler } from "../stripe/webhooks.js";

/**
 * Our plan billing (M8-15; spec 03 · Plan billing; Stripe setup 6 and 7).
 *
 * - `subscribeVenue`: the ops step that starts a venue's plan (a Customer per
 *   organization, a subscription per venue with the per-room item).
 * - `billing.rooms`: the job that sends the room count to Stripe after a
 *   room is added or archived.
 * - The four billing events from our own account, each applied after reading
 *   the subscription (and the invoice) again from Stripe, so a late or
 *   repeated event changes nothing.
 */
export const PLAN_ROOMS_KIND = "billing.rooms";

const FAILED = new Set(["past_due", "unpaid"]);
const GOOD = new Set(["active", "trialing"]);

/** Queue the room count for Stripe, in the same transaction as the room change; no plan, no job. */
export async function queueRoomQuantity(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
): Promise<void> {
  const sub = await venueSubscription(c, venueId);
  if (!sub?.room_item_id) return;
  await enqueue(c, { venueId, kind: PLAN_ROOMS_KIND, pool: "normal", runAt: now, maxAttempts: 10 });
}

/** The room-count job: counts now, sends outside any transaction, then keeps what Stripe took. */
export function makePlanRoomsHandler(stripe: StripeClient): JobHandler {
  return async (job) => {
    const venueId = job.job.venue_id;
    const read = await job.step(async (c) => ({
      sub: await venueSubscription(c, venueId),
      rooms: await billableRooms(c, venueId),
    }));
    if (!read.sub?.room_item_id) return;
    if (read.sub.room_quantity === read.rooms) return;
    // The job's id names the attempt: a retry of this job reuses it, a later room change is a new job.
    const item = await setRoomItemQuantity(
      stripe,
      read.sub.room_item_id,
      read.rooms,
      `billing:rooms:${job.job.id}:${read.rooms}`,
    );
    await job.step(async (c) => {
      await setRoomQuantity(c, venueId, item.quantity);
      await emitEvent(c, { venueId, type: "plan.updated", entityId: venueId });
    });
  };
}

const latestInvoiceId = (s: StripeSubscription): string | null =>
  typeof s.latest_invoice === "string" ? s.latest_invoice : (s.latest_invoice?.id ?? null);

async function applyPlan(
  ctx: StripeEventContext,
  subscriptionId: string,
  decide: (
    sub: StripeSubscription,
  ) => Promise<{ at: string; invoiceId: string | null } | "cleared" | undefined>,
): Promise<void> {
  if (ctx.event.endpoint !== "platform") return;
  const row = await ctx.inVenue((c) => venueSubscription(c, ctx.venueId));
  // Only the venue's own subscription moves it (the venue was found by this id; checked again here).
  if (!row || row.stripe_subscription_id !== subscriptionId) return;
  const sub = await readSubscription(ctx.stripe, subscriptionId);
  const failure = await decide(sub);
  await ctx.inVenue(async (c) => {
    const before = await venueSubscription(c, ctx.venueId, { lock: true });
    const after = await setPlanStatus(c, ctx.venueId, {
      status: sub.status,
      ...(failure ? { failure } : {}),
    });
    if (before?.status !== after?.status || before?.payment_failed_at !== after?.payment_failed_at)
      await emitEvent(c, { venueId: ctx.venueId, type: "plan.updated", entityId: ctx.venueId });
  });
}

const objectOf = (ctx: StripeEventContext) =>
  ((ctx.event.payload as { data?: { object?: Record<string, unknown> } }).data?.object ??
    {}) as Record<string, unknown>;

const onSubscription: StripeEventHandler = async (ctx) => {
  const id = objectOf(ctx)["id"];
  if (typeof id !== "string") return;
  await applyPlan(ctx, id, async (sub) =>
    FAILED.has(sub.status)
      ? { at: ctx.now.toString(), invoiceId: latestInvoiceId(sub) }
      : GOOD.has(sub.status)
        ? "cleared"
        : undefined,
  );
};

const onInvoice: StripeEventHandler = async (ctx) => {
  const id = objectOf(ctx)["id"];
  if (typeof id !== "string") return;
  const invoice = await readInvoice(ctx.stripe, id);
  const subscriptionId = invoiceSubscription(invoice);
  if (!subscriptionId) return;
  await applyPlan(ctx, subscriptionId, async (sub) => {
    // What the invoice is now, whichever event arrived first.
    if (invoice.status === "paid") return GOOD.has(sub.status) ? "cleared" : undefined;
    if (invoice.status === "open" || invoice.status === "uncollectible")
      return ctx.event.type === "invoice.payment_failed" || FAILED.has(sub.status)
        ? { at: ctx.now.toString(), invoiceId: invoice.id }
        : undefined;
    return undefined;
  });
};

export const planEventHandlers: readonly [string, StripeEventHandler][] = [
  ["customer.subscription.updated", onSubscription],
  ["customer.subscription.deleted", onSubscription],
  ["invoice.paid", onInvoice],
  ["invoice.payment_failed", onInvoice],
];

/**
 * Start a venue's plan (ops, audited): the organization's Customer on our
 * own account (made once), then the venue's subscription with its room
 * count. Refused while the plan's prices aren't in Stripe, or if the venue
 * already has a plan. Every call is outside a transaction, each with its key.
 */
export async function subscribeVenue(
  owner: pg.Pool,
  stripe: StripeClient,
  input: { venueId: string; plan: PlanId; testClock?: string | null },
): Promise<{ subscriptionId: string; rooms: number }> {
  const ctx = { venueId: input.venueId, requestId: "ops:billing:subscribe" };
  const venue = await withVenue(owner, ctx, async (c) => {
    const r = await c.query<{
      org_id: string;
      legal_name: string;
      billing_customer_id: string | null;
      owner_email: string | null;
    }>(
      `select v.org_id, o.legal_name, o.billing_customer_id,
              (select u.email from memberships m join users u on u.id = m.user_id
                where m.venue_id = v.id and m.role = 'owner' and m.status = 'active'
                order by m.created_at limit 1) as owner_email
         from venues v join organizations o on o.id = v.org_id where v.id = $1`,
      [input.venueId],
    );
    return {
      ...r.rows[0]!,
      existing: await venueSubscription(c, input.venueId),
      rooms: await billableRooms(c, input.venueId),
    };
  });
  if (!venue.org_id) throw new Error(`no venue ${input.venueId}`);
  if (venue.existing)
    throw new Error(`venue ${input.venueId} already has plan ${venue.existing.plan}`);
  const prices = await planPrices(stripe, input.plan);
  let customer = venue.billing_customer_id;
  if (!customer) {
    customer = (
      await createCustomer(stripe, {
        id: venue.org_id,
        legalName: venue.legal_name,
        email: venue.owner_email,
        testClock: input.testClock ?? null,
      })
    ).id;
    await withVenue(owner, ctx, (c) =>
      c.query("update organizations set billing_customer_id = $2 where id = $1", [
        venue.org_id,
        customer,
      ]),
    );
  }
  const sub = await createSubscription(stripe, {
    venueId: input.venueId,
    customer,
    plan: input.plan,
    prices,
    rooms: venue.rooms,
  });
  const roomItem = prices.room
    ? (sub.items.data.find((i) => i.price.id === prices.room!.id) ?? null)
    : null;
  await withVenue(owner, ctx, async (c) => {
    await insertVenueSubscription(c, {
      venueId: input.venueId,
      plan: input.plan,
      subscriptionId: sub.id,
      roomItemId: roomItem?.id ?? null,
      roomQuantity: PLANS_WITH_ROOMS.includes(input.plan) ? (roomItem?.quantity ?? venue.rooms) : 0,
      status: sub.status,
    });
    await emitEvent(c, { venueId: input.venueId, type: "plan.updated", entityId: input.venueId });
  });
  return { subscriptionId: sub.id, rooms: venue.rooms };
}
