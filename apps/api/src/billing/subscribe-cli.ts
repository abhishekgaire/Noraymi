import pg from "pg";
import { PLAN_IDS, type PlanId } from "@west4/db";
import { loadConfig } from "../config.js";
import { StripeClient } from "../stripe/client.js";
import { loadStripeSettings } from "../stripe/settings.js";
import { subscribeVenue } from "./plan.js";

/**
 * `pnpm --filter @west4/api billing:subscribe -- --venue <id> --plan <bar|rooms|rooms_kitchen> [--test-clock <id>]`
 * (ops, audited; M8-15): starts a venue's plan on our own Stripe account.
 * Whether and when a venue is billed is the founder's call; the prices must
 * already be in Stripe under their lookup keys (apps/api/src/stripe/billing.ts).
 * `--test-clock` attaches a new Customer to a Stripe test clock (test mode only).
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const venueId = arg("venue");
  const plan = arg("plan") as PlanId | undefined;
  if (!venueId || !plan || !PLAN_IDS.includes(plan))
    throw new Error(
      "usage: --venue <venue id> --plan <bar|rooms|rooms_kitchen> [--test-clock <clock id>]",
    );
  const config = loadConfig();
  const stripe = new StripeClient(loadStripeSettings(config.env));
  const testClock = arg("test-clock") ?? null;
  if (testClock && stripe.livemode) throw new Error("test clocks are for test mode only");
  const owner = new pg.Pool({
    connectionString: process.env["DATABASE_URL"] ?? config.databaseUrl,
  });
  try {
    const made = await subscribeVenue(owner, stripe, { venueId, plan, testClock });
    console.warn(
      `Subscription ${made.subscriptionId} started on the ${plan} plan with ${made.rooms} room(s).`,
    );
  } finally {
    await owner.end();
  }
}

if (process.argv[1]?.endsWith("subscribe-cli.ts") || process.argv[1]?.endsWith("subscribe-cli.js"))
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
