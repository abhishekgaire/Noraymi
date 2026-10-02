import {
  readSetting,
  setVenueTerminal,
  stripeAccountOf,
  venueTerminal,
  type Queryable,
} from "@west4/db";
import type { PaySettings, Temporal } from "@west4/shared";
import { StripeError, type StripeClient } from "./client.js";
import { createConfiguration, createLocation, updateConfiguration } from "./terminal.js";

type InVenue = <T>(work: (c: Queryable) => Promise<T>) => Promise<T>;

/** Stripe's terminal can't be set up without the venue's account. */
export class NoStripeAccount extends Error {
  constructor() {
    super("this venue has no Stripe account yet");
  }
}

async function tipScreen(inVenue: InVenue, venueId: string, today: Temporal.PlainDate) {
  const pay = await inVenue((c) => readSetting(c, venueId, "pay", today));
  const tip = (pay?.value as PaySettings | undefined)?.tipScreen;
  if (!tip) throw new Error("pay.tipScreen isn't set");
  return tip;
}

/**
 * The venue's Terminal Configuration and Location (M4-02), made once: the
 * idempotency keys name the venue, so a retry answers the same objects.
 */
export async function ensureTerminal(
  inVenue: InVenue,
  stripe: StripeClient,
  venueId: string,
  today: Temporal.PlainDate,
): Promise<{ account: string; locationId: string; configId: string }> {
  const account = await inVenue((c) => stripeAccountOf(c, venueId));
  if (!account) throw new NoStripeAccount();
  const venue = await inVenue((c) => venueTerminal(c, venueId));
  if (venue.location_id && venue.config_id) {
    // The ids survive a seed reload; make sure Stripe still has the Location (a new sandbox or fake doesn't).
    const still = await stripe
      .call("payments", "GET", `/v1/terminal/locations/${encodeURIComponent(venue.location_id)}`, {
        account,
      })
      .then(() => true)
      .catch((e: unknown) => !(e instanceof StripeError && e.status === 404));
    if (still) return { account, locationId: venue.location_id, configId: venue.config_id };
    await inVenue((c) =>
      c.query(
        "update venues set stripe_location_id = null, stripe_terminal_config_id = null where id = $1",
        [venueId],
      ),
    );
    return ensureTerminal(inVenue, stripe, venueId, today);
  }
  const tip = await tipScreen(inVenue, venueId, today);
  const config = venue.config_id
    ? { id: venue.config_id }
    : await createConfiguration(stripe, account, tip, `venue:${venueId}:terminal-configuration`);
  const location = await createLocation(
    stripe,
    account,
    { displayName: venue.name, address: venue.address ?? {}, configId: config.id },
    `venue:${venueId}:terminal-location`,
  );
  await inVenue((c) =>
    setVenueTerminal(c, venueId, { locationId: location.id, configId: config.id }),
  );
  return { account, locationId: location.id, configId: config.id };
}

/** A save of pay.tipScreen goes to the Terminal Configuration; readers take up to 5 minutes to pick it up. */
export async function pushTipScreen(
  inVenue: InVenue,
  stripe: StripeClient,
  venueId: string,
  today: Temporal.PlainDate,
  key: string,
): Promise<boolean> {
  const venue = await inVenue((c) => venueTerminal(c, venueId));
  const account = await inVenue((c) => stripeAccountOf(c, venueId));
  if (!venue.config_id || !account) return false;
  const tip = await tipScreen(inVenue, venueId, today);
  await updateConfiguration(stripe, account, venue.config_id, tip, key);
  return true;
}
