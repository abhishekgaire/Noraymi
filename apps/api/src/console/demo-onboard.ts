import pg from "pg";
import { StoredClock, removeLocalDemoVenue, withVenue } from "@west4/db";
import { loadEmailSettings } from "../email/settings.js";
import { fakeStripeSettings } from "../stripe/settings.js";
import { FAKE_PROMO_CODE } from "../stripe/fake/index.js";
import { ensureFakePlanPrices } from "../stripe/fake/plans.js";
import { createVenueWithOwner, sendOwnerInvite, type VenueTx } from "./new-venue.js";

/**
 * Local demo only: Sing Sing made the way our Console makes a new customer's
 * venue (O-01), for its owner to set up through Set up your venue
 * (`scripts/demo-start.sh --onboard`, `scripts/demo-local.sh --onboard`;
 * docs/manual-test.md, "Onboard Sing Sing yourself"). Run after West 4's seed.
 *   1. removes the last `singsing` venue, if any (this path's or the
 *      `--sing-sing` shortcut's), with its @singsing.demo.local people;
 *   2. as the seed's Console staff member, through the Console route's own code
 *      (createVenueWithOwner, sendOwnerInvite): a new organization, the venue
 *      "Sing Sing Karaoke Astoria" (slug `singsing`) and its owner's invite,
 *      emailed (the worker hands it to Mailpit). Nothing else: no address,
 *      hours, rooms, menu, staff, settings or features;
 *   3. the plans' Prices on the fake Stripe (made-up test amounts), so step 2
 *      has plans to show;
 *   4. prints the owner's invite link.
 * Refuses anything but WEST4_ENV=local on a local database.
 */
export const ONBOARD_SLUG = "singsing";
export const ONBOARD_EMAIL_DOMAIN = "singsing.demo.local";
export const ONBOARD_VENUE_NAME = "Sing Sing Karaoke Astoria";
/** The legal name isn't given yet (docs/venues/sing-sing/venue.md); the owner types it in step 1. */
export const ONBOARD_LEGAL_NAME = "Sing Sing (legal name to confirm in step 1)";
export const ONBOARD_OWNER = { name: "Abhishek G.", email: `abhishek@${ONBOARD_EMAIL_DOMAIN}` };
const CONSOLE_STAFF_EMAIL = "support@demo.west4.local";

function localOnly(url: string, what: string): string {
  if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(url).hostname))
    throw new Error(`demo-onboard: ${what} isn't a local database (${new URL(url).hostname})`);
  return url;
}

/** Steps 1 and 2: `owner` is the table owner (the cleanup), `app` the API's app_rw pool. */
export async function onboardDemoVenue(options: {
  readonly owner: pg.ClientBase;
  readonly app: pg.Pool;
  readonly staffAppUrl: string;
}): Promise<{ venueId: string; orgId: string; inviteUrl: string; sentTo: string }> {
  const { owner, app: pool } = options;
  await removeLocalDemoVenue(owner, { slug: ONBOARD_SLUG, emailDomain: ONBOARD_EMAIL_DOMAIN });
  const staff = await owner.query<{ id: string }>(
    "select id from console_staff where lower(email) = $1 and active",
    [CONSOLE_STAFF_EMAIL],
  );
  const staffId = staff.rows[0]?.id;
  if (!staffId) throw new Error("demo-onboard: no Console staff member; run pnpm seed first");
  // The demo's stored clock, as the API and the worker read it.
  const clock = new StoredClock(pool);
  await clock.refresh(true);
  const venueTx: VenueTx = (context, work) => withVenue(pool, context, work);
  const made = await createVenueWithOwner(venueTx, {
    staffId,
    requestId: "demo-onboard",
    name: ONBOARD_VENUE_NAME,
    slug: ONBOARD_SLUG,
    orgId: null,
    legalName: ONBOARD_LEGAL_NAME,
    ownerName: ONBOARD_OWNER.name,
    ownerEmail: ONBOARD_OWNER.email,
    reason: "Local demo: the founder onboards Sing Sing through Set up your venue (--onboard)",
  });
  const sent = await sendOwnerInvite(venueTx, {
    staffId,
    requestId: "demo-onboard",
    venueId: made.venueId,
    venueName: ONBOARD_VENUE_NAME,
    now: clock.now(),
    email: loadEmailSettings("local"),
    staffAppUrl: options.staffAppUrl,
  });
  return {
    venueId: made.venueId,
    orgId: made.orgId,
    inviteUrl: sent.inviteUrl,
    sentTo: sent.sentTo,
  };
}

async function main(): Promise<void> {
  if ((process.env["WEST4_ENV"] ?? "local") !== "local")
    throw new Error("demo-onboard: local only (WEST4_ENV isn't local)");
  const owner = new pg.Client({
    connectionString: localOnly(
      process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
      "DATABASE_URL",
    ),
    application_name: "west4-demo-onboard",
  });
  const app = new pg.Pool({
    connectionString: localOnly(
      process.env["APP_DATABASE_URL"] ?? "postgres://app_rw:app_rw@localhost:5432/west4",
      "APP_DATABASE_URL",
    ),
    max: 2,
    application_name: "west4-demo-onboard",
  });
  await owner.connect();
  const made = await onboardDemoVenue({
    owner,
    app,
    staffAppUrl: process.env["STAFF_APP_URL"] ?? "http://localhost:5173",
  }).finally(() => Promise.all([owner.end(), app.end()]));
  let prices = "The plans' test prices are on the fake Stripe.";
  try {
    await ensureFakePlanPrices(
      fakeStripeSettings(process.env["STRIPE_API_BASE"] || undefined).apiBase,
    );
  } catch (error) {
    prices = `! The fake Stripe isn't answering (${(error as Error).message}), so step 2 has no plans to show. Start the demo with scripts/demo-start.sh --onboard.`;
  }
  const mailpit = process.env["MAILPIT_URL"] ?? "http://localhost:8025";
  process.stdout.write(`Sing Sing Karaoke Astoria is made, empty, as our Console makes a new venue.
  Owner's invite (${made.sentTo}): ${made.inviteUrl}
  The same invite by email, and every sign-in code: ${mailpit}  (or scripts/demo-codes.sh)
  ${prices}
  Promo code for step 2 (the fake Stripe's test code): ${FAKE_PROMO_CODE}
Open the link, then Set up your venue walks you through 12 steps (docs/manual-test.md section 29).\n`);
}

if (process.argv[1]?.endsWith("demo-onboard.ts") || process.argv[1]?.endsWith("demo-onboard.js"))
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
