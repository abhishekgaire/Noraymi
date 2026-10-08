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
    `billing:subscription:${input.venueId}:${input.plan}`,
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
