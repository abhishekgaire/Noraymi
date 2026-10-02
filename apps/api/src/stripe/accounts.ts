import type { StripeClient } from "./client.js";

/**
 * Accounts v2 (M4-01; Stripe setup 1 and 2). Stripe's examples for Accounts
 * v2 use a preview API version, so this module, and the surcharge path, are
 * the only places that may name a version other than the pinned one (the
 * check-stripe-versions script fails CI otherwise). Which features are on
 * stable versions is open with Stripe (Open technical questions).
 */
export const ACCOUNTS_V2_VERSION = "2026-08-26.preview";

export interface VenueAccountInput {
  readonly displayName: string;
  readonly contactEmail: string;
  readonly registeredName: string;
}

export interface AccountV2 {
  readonly id: string;
  readonly display_name?: string;
  readonly configuration?: {
    readonly merchant?: {
      readonly capabilities?: { readonly card_payments?: { readonly status?: string } };
      /** The merchant category code Stripe has for the account (M4-29). */
      readonly mcc?: string | null;
    };
  };
  readonly defaults?: {
    readonly responsibilities?: {
      readonly fees_collector?: string;
      readonly losses_collector?: string;
    };
  };
  readonly requirements?: {
    readonly entries?: readonly {
      readonly description?: string;
      readonly minimum_deadline?: { readonly status?: string };
    }[];
  };
}

/** What Admin → Payments shows, and the `integrations` row (kind stripe) keeps. */
export interface AccountStatus {
  readonly accountId: string;
  /** Stripe's word for card payments: active, pending, restricted or unsupported. */
  readonly cardPayments: string;
  readonly cardPaymentsEnabled: boolean;
  /** What Stripe still needs, in Stripe's words, when anything is currently or past due. */
  readonly needs: readonly string[];
}

/** POST /v2/core/accounts: the venue pays Stripe's fees and Stripe covers losses (as decided). */
export async function createVenueAccount(
  stripe: StripeClient,
  input: VenueAccountInput,
  idempotencyKey: string,
): Promise<AccountV2> {
  return stripe.call<AccountV2>("payments", "POST", "/v2/core/accounts", {
    account: null,
    platform: true,
    version: ACCOUNTS_V2_VERSION,
    idempotencyKey,
    params: {
      display_name: input.displayName,
      contact_email: input.contactEmail,
      dashboard: "full",
      identity: {
        country: "us",
        entity_type: "company",
        business_details: { registered_name: input.registeredName },
      },
      configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
      defaults: {
        currency: "usd",
        responsibilities: { fees_collector: "stripe", losses_collector: "stripe" },
      },
    },
  });
}

export async function retrieveAccount(stripe: StripeClient, accountId: string): Promise<AccountV2> {
  return stripe.call<AccountV2>(
    "reporting",
    "GET",
    `/v2/core/accounts/${encodeURIComponent(accountId)}`,
    {
      account: null,
      platform: true,
      version: ACCOUNTS_V2_VERSION,
      params: { include: ["configuration.merchant", "requirements"] },
    },
  );
}

export function accountStatus(account: AccountV2): AccountStatus {
  const card = account.configuration?.merchant?.capabilities?.card_payments?.status ?? "pending";
  const needs = (account.requirements?.entries ?? [])
    .filter((e) => ["currently_due", "past_due"].includes(e.minimum_deadline?.status ?? ""))
    .map((e) => e.description ?? "")
    .filter(Boolean);
  return {
    accountId: account.id,
    cardPayments: card,
    cardPaymentsEnabled: card === "active",
    needs,
  };
}

/** Stripe's hosted onboarding for the account: bank details and IDs never pass through us. */
export async function onboardingLink(
  stripe: StripeClient,
  accountId: string,
  urls: { refreshUrl: string; returnUrl: string },
  idempotencyKey: string,
): Promise<string> {
  const link = await stripe.call<{ url: string }>("payments", "POST", "/v2/core/account_links", {
    account: null,
    platform: true,
    version: ACCOUNTS_V2_VERSION,
    idempotencyKey,
    params: {
      account: accountId,
      use_case: {
        type: "account_onboarding",
        account_onboarding: {
          configurations: ["merchant"],
          refresh_url: urls.refreshUrl,
          return_url: urls.returnUrl,
        },
      },
    },
  });
  return link.url;
}

export interface Payout {
  readonly id: string;
  readonly amount: number;
  readonly arrival_date: number;
  readonly status: string;
}

/** The venue's payouts as Stripe lists them, read with the reporting key (matching them comes in M7). */
export async function listPayouts(
  stripe: StripeClient,
  accountId: string,
): Promise<readonly Payout[]> {
  const page = await stripe.call<{ data: Payout[] }>("reporting", "GET", "/v1/payouts", {
    account: accountId,
    params: { limit: 20 },
  });
  return page.data;
}
