import type { PlanId } from "@west4/db";
import type { StripeClient } from "./client.js";

/**
 * Our plan billing on Stripe Billing (M8-15; Stripe setup 7): every call
 * here runs on our own platform account with the billing key, never with
 * `Stripe-Account`, never inside a database transaction, and every write
 * carries an idempotency key.
 *
 * Prices aren't ours to invent: the founder sets them after the pilots
 * (blueprint · Proposed plans, Open decisions). They live in Stripe as Price
 * objects found by lookup key, so no amount is written in our code or
 * settings; until they exist, a venue can't be subscribed and Admin says so.
 */
export const PLAN_LOOKUP_KEYS: Readonly<Record<PlanId, string>> = {
  bar: "west4_plan_bar",
  rooms: "west4_plan_rooms",
  rooms_kitchen: "west4_plan_rooms_kitchen",
};
/** The per-room fee, on the plans with rooms. */
export const ROOM_LOOKUP_KEY = "west4_plan_room";
export const PLANS_WITH_ROOMS: readonly PlanId[] = ["rooms", "rooms_kitchen"];

export interface StripePrice {
  readonly id: string;
  readonly lookup_key: string | null;
  readonly unit_amount: number | null;
  readonly currency: string;
  readonly recurring: { readonly interval: string } | null;
}

export interface StripeSubscription {
  readonly id: string;
  readonly status: string;
  readonly customer: string;
  readonly latest_invoice: string | { id: string } | null;
  readonly items: {
    readonly data: readonly {
      readonly id: string;
      readonly quantity?: number;
      readonly price: { readonly id: string; readonly lookup_key?: string | null };
    }[];
  };
}

export interface StripeInvoice {
  readonly id: string;
  readonly status: string;
  readonly amount_due: number;
  readonly currency: string;
  readonly hosted_invoice_url?: string | null;
  readonly next_payment_attempt?: number | null;
  readonly period_end?: number;
  readonly subscription?: string | null;
  readonly parent?: {
    readonly subscription_details?: { readonly subscription?: string | null } | null;
  } | null;
}

export class PlanPricesMissing extends Error {
  constructor(readonly lookupKeys: readonly string[]) {
    super(`plan prices aren't in Stripe yet: ${lookupKeys.join(", ")}`);
    this.name = "PlanPricesMissing";
  }
}

const billing = <T>(
  stripe: StripeClient,
  method: "GET" | "POST",
  path: string,
  params?: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<T> =>
  stripe.call<T>("billing", method, path, {
    account: null,
    ...(params ? { params } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });

/** The plan's prices by lookup key; refuses if any is missing. */
export async function planPrices(
  stripe: StripeClient,
  plan: PlanId,
): Promise<{ base: StripePrice; room: StripePrice | null }> {
  const keys = [
    PLAN_LOOKUP_KEYS[plan],
    ...(PLANS_WITH_ROOMS.includes(plan) ? [ROOM_LOOKUP_KEY] : []),
  ];
  const list = await billing<{ data: StripePrice[] }>(stripe, "GET", "/v1/prices", {
    lookup_keys: keys,
    active: true,
  });
  const byKey = new Map(list.data.map((p) => [p.lookup_key, p]));
  const missing = keys.filter((k) => !byKey.has(k));
  if (missing.length > 0) throw new PlanPricesMissing(missing);
  return {
    base: byKey.get(PLAN_LOOKUP_KEYS[plan])!,
    room: PLANS_WITH_ROOMS.includes(plan) ? byKey.get(ROOM_LOOKUP_KEY)! : null,
  };
}

export async function createCustomer(
  stripe: StripeClient,
  org: { id: string; legalName: string; email: string | null; testClock?: string | null },
): Promise<{ id: string }> {
  return billing(
    stripe,
    "POST",
    "/v1/customers",
    {
      name: org.legalName,
      ...(org.email ? { email: org.email } : {}),
      metadata: { organization_id: org.id },
      ...(org.testClock ? { test_clock: org.testClock } : {}),
    },
    `billing:customer:${org.id}`,
  );
}

export async function createSubscription(
  stripe: StripeClient,
  input: {
    /** The stored subscribe attempt (plan_subscribe_attempts): one key per attempt, the same on its retries. */
    attemptId: string;
    venueId: string;
    customer: string;
    plan: PlanId;
    prices: { base: StripePrice; room: StripePrice | null };
    rooms: number;
  },
): Promise<StripeSubscription> {
  const items: Record<string, unknown>[] = [{ price: input.prices.base.id, quantity: 1 }];
  if (input.prices.room) items.push({ price: input.prices.room.id, quantity: input.rooms });
  return billing(
    stripe,
    "POST",
    "/v1/subscriptions",
    {
      customer: input.customer,
      items,
      // Stripe retries the card on its own schedule; Admin's 14 days run on our clock.
      payment_behavior: "allow_incomplete",
      metadata: { venue_id: input.venueId, plan: input.plan },
    },
    `billing:subscription:${input.venueId}:${input.attemptId}`,
  );
}

export const readSubscription = (stripe: StripeClient, id: string) =>
  billing<StripeSubscription>(stripe, "GET", `/v1/subscriptions/${encodeURIComponent(id)}`);

export const readInvoice = (stripe: StripeClient, id: string) =>
  billing<StripeInvoice>(stripe, "GET", `/v1/invoices/${encodeURIComponent(id)}`);

/** The room count on the per-room item; the key names the job that sends it. */
export const setRoomItemQuantity = (
  stripe: StripeClient,
  itemId: string,
  quantity: number,
  key: string,
) =>
  billing<{ id: string; quantity: number }>(
    stripe,
    "POST",
    `/v1/subscription_items/${encodeURIComponent(itemId)}`,
    { quantity },
    key,
  );

/** The next invoice as Stripe previews it. */
export const previewInvoice = (
  stripe: StripeClient,
  customer: string,
  subscription: string,
  key: string,
) =>
  billing<StripeInvoice>(
    stripe,
    "POST",
    "/v1/invoices/create_preview",
    { customer, subscription },
    key,
  );

export interface StripeCustomer {
  readonly id: string;
  readonly invoice_settings?: {
    readonly default_payment_method?:
      | string
      | { readonly id: string; readonly card?: { brand: string; last4: string } | null }
      | null;
  };
}

export const readCustomer = (stripe: StripeClient, id: string) =>
  billing<StripeCustomer>(stripe, "GET", `/v1/customers/${encodeURIComponent(id)}`, {
    expand: ["invoice_settings.default_payment_method"],
  });

/** Stripe's hosted customer portal: the plan, invoices and the payment method, never through us. */
export const portalSession = (
  stripe: StripeClient,
  customer: string,
  returnUrl: string,
  key: string,
) =>
  billing<{ url: string }>(
    stripe,
    "POST",
    "/v1/billing_portal/sessions",
    { customer, return_url: returnUrl },
    key,
  );

/** The subscription an invoice belongs to (moved under `parent` in Stripe's 2025 API). */
export function invoiceSubscription(invoice: StripeInvoice): string | null {
  return invoice.parent?.subscription_details?.subscription ?? invoice.subscription ?? null;
}

/** Every plan Price by lookup key (O-04): what the plan cards show; a key not found is left out. */
export async function allPlanPrices(stripe: StripeClient): Promise<Map<string, StripePrice>> {
  const list = await billing<{ data: StripePrice[] }>(stripe, "GET", "/v1/prices", {
    lookup_keys: [...Object.values(PLAN_LOOKUP_KEYS), ROOM_LOOKUP_KEY],
    active: true,
  });
  return new Map(
    list.data.filter((p) => p.lookup_key).map((p) => [p.lookup_key!, p] as [string, StripePrice]),
  );
}

export interface StripeCoupon {
  readonly id: string;
  readonly valid?: boolean;
  readonly percent_off?: number | null;
  readonly amount_off?: number | null;
  readonly currency?: string | null;
  readonly duration: "once" | "repeating" | "forever";
  readonly duration_in_months?: number | null;
}

export interface StripePromotionCode {
  readonly id: string;
  readonly code: string;
  readonly active: boolean;
  readonly expires_at?: number | null;
  readonly max_redemptions?: number | null;
  readonly times_redeemed?: number;
  /** Stripe's 2025 API moved the coupon under `promotion`; older answers carry `coupon`. */
  readonly promotion?: { readonly coupon?: string | StripeCoupon | null } | null;
  readonly coupon?: string | StripeCoupon | null;
}

/**
 * The owner's promo code against our account's active Promotion Codes (D114):
 * null when it doesn't exist, has expired, is used up or its coupon has ended.
 * The code is the founder's, made in Stripe; ours never names one.
 */
export async function findPromotionCode(
  stripe: StripeClient,
  code: string,
  nowS: number,
): Promise<{ promo: StripePromotionCode; coupon: StripeCoupon } | null> {
  const list = await billing<{ data: StripePromotionCode[] }>(
    stripe,
    "GET",
    "/v1/promotion_codes",
    { code, active: true, limit: 1, expand: ["data.promotion.coupon", "data.coupon"] },
  );
  const promo = list.data.find((p) => p.code.toLowerCase() === code.toLowerCase() && p.active);
  if (!promo) return null;
  const raw = promo.promotion?.coupon ?? promo.coupon ?? null;
  if (!raw || typeof raw === "string") return null;
  if (raw.valid === false) return null;
  if (promo.expires_at && promo.expires_at <= nowS) return null;
  if (promo.max_redemptions && (promo.times_redeemed ?? 0) >= promo.max_redemptions) return null;
  return { promo, coupon: raw };
}

export interface StripeCheckoutSession {
  readonly id: string;
  readonly status: "open" | "complete" | "expired";
  readonly url: string | null;
  readonly expires_at: number;
  readonly customer: string | null;
  readonly subscription: string | null;
}

/**
 * Start plan's Checkout Session in subscription mode on our own account
 * (O-04): the plan's Price, the per-room Price with the room count (left out
 * while the venue has no rooms; the room-count job adds it with the first
 * room), and the promotion code. One key per attempt, never in a transaction.
 */
export async function createCheckoutSession(
  stripe: StripeClient,
  input: {
    attemptId: string;
    venueId: string;
    customer: string;
    plan: PlanId;
    prices: { base: StripePrice; room: StripePrice | null };
    rooms: number;
    promotionCodeId: string | null;
    successUrl: string;
    cancelUrl: string;
  },
): Promise<StripeCheckoutSession> {
  const lineItems: Record<string, unknown>[] = [{ price: input.prices.base.id, quantity: 1 }];
  if (input.prices.room && input.rooms > 0)
    lineItems.push({ price: input.prices.room.id, quantity: input.rooms });
  return billing(
    stripe,
    "POST",
    "/v1/checkout/sessions",
    {
      mode: "subscription",
      customer: input.customer,
      line_items: lineItems,
      ...(input.promotionCodeId ? { discounts: [{ promotion_code: input.promotionCodeId }] } : {}),
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.attemptId,
      subscription_data: { metadata: { venue_id: input.venueId, plan: input.plan } },
    },
    `billing:checkout:${input.venueId}:${input.attemptId}`,
  );
}

export const readCheckoutSession = (stripe: StripeClient, id: string) =>
  billing<StripeCheckoutSession>(stripe, "GET", `/v1/checkout/sessions/${encodeURIComponent(id)}`);

/** The per-room item, added once the first room exists on a plan started with none. */
export const addRoomItem = (
  stripe: StripeClient,
  input: { subscription: string; price: string; quantity: number },
  key: string,
) =>
  billing<{ id: string; quantity: number }>(
    stripe,
    "POST",
    "/v1/subscription_items",
    { subscription: input.subscription, price: input.price, quantity: input.quantity },
    key,
  );

/** Which plan a subscription's Prices are, by lookup key; null when none of ours is on it. */
export function planOfSubscription(
  sub: StripeSubscription,
): { plan: PlanId; roomItem: { id: string; quantity: number } | null } | null {
  const keys = sub.items.data.map((i) => i.price.lookup_key ?? null);
  const plan = (Object.entries(PLAN_LOOKUP_KEYS) as [PlanId, string][]).find(([, k]) =>
    keys.includes(k),
  )?.[0];
  if (!plan) return null;
  const room = sub.items.data.find((i) => i.price.lookup_key === ROOM_LOOKUP_KEY);
  return { plan, roomItem: room ? { id: room.id, quantity: room.quantity ?? 0 } : null };
}
