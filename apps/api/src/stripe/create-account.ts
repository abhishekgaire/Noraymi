import { saveStripeIntegration, withVenue } from "@west4/db";
import pg from "pg";
import { loadConfig } from "../config.js";
import { StripeClient, stripeFromEnv } from "./client.js";
import { accountStatus, createVenueAccount } from "./accounts.js";
import { loadStripeSettings } from "./settings.js";

/**
 * `pnpm --filter @west4/api stripe:create-account --org <id> [--email <contact>]`
 * (M4-01; Stripe setup 1): our staff make an organization's Stripe account
 * with Accounts v2 (the venue pays Stripe's fees and Stripe covers losses)
 * and store its id in `organizations.stripe_account_id`. The change is
 * audited (the organizations trigger, with request id `ops:stripe:create-account`).
 * It refuses an organization that already has an account, and an account id
 * another organization holds. The contact email defaults to the owner's.
 */
export async function createAccountFor(
  owner: pg.Pool,
  stripe: StripeClient,
  orgId: string,
  email?: string,
): Promise<{ accountId: string; venues: string[] }> {
  const org = (
    await owner.query<{ legal_name: string; stripe_account_id: string | null }>(
      "select legal_name, stripe_account_id from organizations where id = $1",
      [orgId],
    )
  ).rows[0];
  if (!org) throw new Error(`no organization ${orgId}`);
  if (org.stripe_account_id)
    throw new Error(`organization ${orgId} already has Stripe account ${org.stripe_account_id}`);
  const venues = (
    await owner.query<{ id: string; name: string; owner_email: string | null }>(
      `select v.id, v.name,
              (select u.email from memberships m join users u on u.id = m.user_id
                where m.venue_id = v.id and m.role = 'owner' and m.status = 'active'
                order by m.created_at limit 1) as owner_email
         from venues v where v.org_id = $1 order by v.created_at`,
      [orgId],
    )
  ).rows;
  if (venues.length === 0) throw new Error(`organization ${orgId} has no venue`);
  const contact = email ?? venues[0]!.owner_email;
  if (!contact) throw new Error("no owner email; pass --email");
  const account = await createVenueAccount(
    stripe,
    { displayName: venues[0]!.name, contactEmail: contact, registeredName: org.legal_name },
    `org:${orgId}:create-account`,
  );
  const taken = await owner.query("select 1 from organizations where stripe_account_id = $1", [
    account.id,
  ]);
  if (taken.rowCount)
    throw new Error(`Stripe account ${account.id} already belongs to another organization`);
  const status = accountStatus(account);
  const at = new Date().toISOString();
  await withVenue(owner, { venueId: venues[0]!.id, requestId: "ops:stripe:create-account" }, (c) =>
    c.query("update organizations set stripe_account_id = $2 where id = $1", [orgId, account.id]),
  );
  for (const v of venues)
    await withVenue(owner, { venueId: v.id, requestId: "ops:stripe:create-account" }, (c) =>
      saveStripeIntegration(c, v.id, {
        accountId: account.id,
        cardPayments: status.cardPayments,
        needs: status.needs,
        at,
      }),
    );
  return { accountId: account.id, venues: venues.map((v) => v.id) };
}

/**
 * Training mode's sandbox account (M7-04): the same organization's connected
 * account in the sandbox, made with the sandbox's keys and stored in
 * `organizations.stripe_training_account_id`. Practice payments, and only
 * they, run on it. Ops onboard it with Stripe's test data in the sandbox.
 */
export async function createTrainingAccountFor(
  owner: pg.Pool,
  stripe: StripeClient,
  orgId: string,
  email?: string,
): Promise<{ accountId: string }> {
  const org = (
    await owner.query<{
      legal_name: string;
      id: string | null;
      venue: string | null;
      name: string | null;
    }>(
      `select o.legal_name, o.stripe_training_account_id as id,
              (select v.id from venues v where v.org_id = o.id order by v.created_at limit 1) as venue,
              (select v.name from venues v where v.org_id = o.id order by v.created_at limit 1) as name
         from organizations o where o.id = $1`,
      [orgId],
    )
  ).rows[0];
  if (!org) throw new Error(`no organization ${orgId}`);
  if (org.id) throw new Error(`organization ${orgId} already has sandbox account ${org.id}`);
  if (!org.venue) throw new Error(`organization ${orgId} has no venue`);
  const account = await createVenueAccount(
    stripe.forTraining(true),
    {
      displayName: org.name ?? org.legal_name,
      contactEmail: email ?? "training@demo.west4.local",
      registeredName: org.legal_name,
    },
    `org:${orgId}:create-training-account`,
  );
  await withVenue(owner, { venueId: org.venue, requestId: "ops:stripe:create-account" }, (c) =>
    c.query("update organizations set stripe_training_account_id = $2 where id = $1", [
      orgId,
      account.id,
    ]),
  );
  return { accountId: account.id };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const orgId = arg("org");
  if (!orgId)
    throw new Error("usage: --org <organization id> [--email <contact email>] [--sandbox]");
  const config = loadConfig();
  const owner = new pg.Pool({
    connectionString: process.env["DATABASE_URL"] ?? config.databaseUrl,
  });
  try {
    if (args.includes("--sandbox")) {
      const made = await createTrainingAccountFor(
        owner,
        stripeFromEnv(config.env),
        orgId,
        arg("email"),
      );
      console.warn(`Sandbox account ${made.accountId} made and stored for training mode.`);
      return;
    }
    const made = await createAccountFor(
      owner,
      new StripeClient(loadStripeSettings(config.env)),
      orgId,
      arg("email"),
    );
    console.warn(
      `Stripe account ${made.accountId} made and stored for ${made.venues.length} venue(s). The owner finishes onboarding in Admin → Payments.`,
    );
  } finally {
    await owner.end();
  }
}

if (
  process.argv[1]?.endsWith("create-account.ts") ||
  process.argv[1]?.endsWith("create-account.js")
)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
