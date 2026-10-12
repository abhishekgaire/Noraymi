import { businessDate } from "@west4/rules";
import { stripeAccountOf, venueClockSettings, type Queryable } from "@west4/db";
import type { Temporal } from "@west4/shared";
import type { StripeClient } from "./client.js";
import { registerPayDomain } from "./payments.js";
import { NoTipScreen, ensureTerminal } from "./terminal-setup.js";

type InVenue = <T>(work: (c: Queryable) => Promise<T>) => Promise<T>;

/**
 * Once card payments are on (O-05; Stripe setup 4 and 10): the payment
 * page's domain on the account for Apple Pay and Google Pay, and the venue's
 * Terminal Configuration and Location once its tip screen is saved. Both are made once (their keys name
 * the venue and the domain), outside any transaction, so a repeated
 * `account.updated` answers the same objects. A local host can't be registered.
 */
export async function whenCardPaymentsOn(
  inVenue: InVenue,
  stripe: StripeClient,
  venueId: string,
  now: Temporal.Instant,
  payAppUrl: string | null,
): Promise<void> {
  const account = await inVenue((c) => stripeAccountOf(c, venueId));
  if (!account) return;
  const host = payAppUrl ? new URL(payAppUrl).hostname : null;
  if (host && !/(^|\.)localhost$/.test(host) && host !== "127.0.0.1")
    await registerPayDomain(stripe, account, host);
  const zone = await inVenue((c) => venueClockSettings(c, venueId));
  const today = businessDate(now, zone.time_zone, zone.day_cutover).businessDate;
  try {
    await ensureTerminal(inVenue, stripe, venueId, today);
  } catch (e) {
    // A new venue hasn't chosen its tip screen yet (we never pick one for it): the Location is
    // made when it has, at the first reader's registration (Admin → Printers & devices).
    if (!(e instanceof NoTipScreen)) throw e;
  }
}
