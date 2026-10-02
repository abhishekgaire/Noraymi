import type { PaySettings } from "@west4/shared";
import type { StripeClient } from "./client.js";

/**
 * Stripe Terminal setup (M4-02; Stripe setup 4): one Configuration per venue
 * with its tip choices and cellular on, a Location that uses it, and each
 * reader registered to the Location with the code it shows. Every call runs
 * on the venue's account with the payments key, outside any transaction.
 */
export type ReaderModel = "stripe_s710" | "stripe_s700" | "bbpos_wisepos_e";
export const SUPPORTED_READERS: readonly ReaderModel[] = [
  "stripe_s710",
  "stripe_s700",
  "bbpos_wisepos_e",
];
/** Only the S710 has cellular, at $10 a reader a month; the others are "no cellular backup". */
export const CELLULAR_FEE_CENTS = 1000;
export const hasCellular = (model: ReaderModel): boolean => model === "stripe_s710";

/**
 * The model a reader reports, as one of ours or null. Stripe's sandbox reports a simulated reader
 * as "simulated_stripe_s710" and so on; outside live mode that counts as the model it simulates.
 */
export function readerModel(deviceType: string, livemode: boolean): ReaderModel | null {
  const type =
    !livemode && deviceType.startsWith("simulated_")
      ? deviceType.slice("simulated_".length)
      : deviceType;
  return (SUPPORTED_READERS as readonly string[]).includes(type) ? (type as ReaderModel) : null;
}

export interface StripeReader {
  readonly id: string;
  readonly label: string | null;
  readonly location: string | null;
  readonly device_type: string;
  readonly status: "online" | "offline" | null;
  readonly serial_number?: string;
  readonly action?: Record<string, unknown> | null;
}

/** pay.tipScreen as a Terminal Configuration: 18, 20, 22%, and $1, $2, $3 under $10 at West 4. */
export function configurationParams(tip: PaySettings["tipScreen"]): Record<string, unknown> {
  return {
    tipping: {
      usd: {
        percentages: [...tip.pcts],
        smart_tip_threshold: tip.smartThresholdCents,
        fixed_amounts: [...tip.fixedCents],
      },
    },
    cellular: { enabled: true },
  };
}

export async function createConfiguration(
  stripe: StripeClient,
  account: string,
  tip: PaySettings["tipScreen"],
  idempotencyKey: string,
): Promise<{ id: string }> {
  return stripe.call("payments", "POST", "/v1/terminal/configurations", {
    account,
    idempotencyKey,
    params: configurationParams(tip),
  });
}

export async function updateConfiguration(
  stripe: StripeClient,
  account: string,
  configId: string,
  tip: PaySettings["tipScreen"],
  idempotencyKey: string,
): Promise<{ id: string }> {
  return stripe.call(
    "payments",
    "POST",
    `/v1/terminal/configurations/${encodeURIComponent(configId)}`,
    {
      account,
      idempotencyKey,
      params: configurationParams(tip),
    },
  );
}

export async function createLocation(
  stripe: StripeClient,
  account: string,
  input: {
    displayName: string;
    address: { line1?: string; city?: string; state?: string; postal_code?: string };
    configId: string;
  },
  idempotencyKey: string,
): Promise<{ id: string }> {
  return stripe.call("payments", "POST", "/v1/terminal/locations", {
    account,
    idempotencyKey,
    params: {
      display_name: input.displayName,
      address: { ...input.address, country: "US" },
      configuration_overrides: input.configId,
    },
  });
}

export async function registerReader(
  stripe: StripeClient,
  account: string,
  input: { registrationCode: string; label: string; location: string },
  idempotencyKey: string,
): Promise<StripeReader> {
  return stripe.call("payments", "POST", "/v1/terminal/readers", {
    account,
    idempotencyKey,
    params: {
      registration_code: input.registrationCode,
      label: input.label,
      location: input.location,
    },
  });
}

export async function deleteReader(
  stripe: StripeClient,
  account: string,
  readerId: string,
): Promise<void> {
  await stripe.call("payments", "DELETE", `/v1/terminal/readers/${encodeURIComponent(readerId)}`, {
    account,
  });
}

export async function listReaders(
  stripe: StripeClient,
  account: string,
  location: string,
): Promise<readonly StripeReader[]> {
  const page = await stripe.call<{ data: StripeReader[] }>(
    "payments",
    "GET",
    "/v1/terminal/readers",
    {
      account,
      params: { location, limit: 100 },
    },
  );
  return page.data;
}

export async function retrieveReader(
  stripe: StripeClient,
  account: string,
  readerId: string,
): Promise<StripeReader> {
  return stripe.call("payments", "GET", `/v1/terminal/readers/${encodeURIComponent(readerId)}`, {
    account,
  });
}
