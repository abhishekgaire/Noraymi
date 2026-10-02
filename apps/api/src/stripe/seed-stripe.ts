import { saveReader, setPaymentIntent, venueReaders, withVenue, type Queryable } from "@west4/db";
import { businessDate } from "@west4/rules";
import { SEED_NOW } from "@west4/shared";
import pg from "pg";
import { loadConfig } from "../config.js";
import { StripeClient, StripeError } from "./client.js";
import { retrieveAccount } from "./accounts.js";
import { createAccountFor } from "./create-account.js";
import { loadStripeSettings } from "./settings.js";
import { hasCellular, listReaders, readerModel, registerReader } from "./terminal.js";
import { ensureTerminal } from "./terminal-setup.js";

/**
 * `pnpm --filter @west4/api stripe:seed` (M4-10): after `pnpm seed`, puts the
 * demo night's Stripe side in place on whatever Stripe this environment uses
 * (the connected sandbox in staging, the fake locally):
 *  - West 4's account (kept across reloads; the fake gets a new one when it
 *    restarts, a sandbox never does: a stored id the sandbox doesn't know is
 *    an error to fix by hand, not a second account);
 *  - its Terminal Location, and "Bar S710" and "Front desk S710" attached by
 *    label (registered as simulated S710s when missing, never in live mode);
 *  - every deposit backed by a real PaymentIntent: a Customer and Stripe's
 *    test card of the seed's brand, confirmed, the card saved for later
 *    charges, so refunds and card on file work. Our rows keep the seed's
 *    brand and last four for display (Stripe's test Amex ends in 0005).
 * Nothing runs in live mode, and nothing runs inside a transaction.
 */
const TEST_PM: Record<string, string> = {
  amex: "pm_card_amex",
  visa: "pm_card_visa",
  mastercard: "pm_card_mastercard",
  discover: "pm_card_discover",
};

export async function seedStripe(
  owner: pg.Pool,
  stripe: StripeClient,
  log: (line: string) => void = (l) => console.warn(l),
): Promise<{ account: string; readers: number; deposits: number }> {
  if (stripe.livemode) throw new Error("stripe:seed never runs against live Stripe");
  const venue = (
    await owner.query<{
      id: string;
      org_id: string;
      time_zone: string;
      day_cutover: string;
      account: string | null;
    }>(
      `select v.id, v.org_id, v.time_zone, to_char(v.day_cutover, 'HH24:MI') as day_cutover,
              o.stripe_account_id as account
         from venues v join organizations o on o.id = v.org_id where v.slug = 'west4karaoke'`,
    )
  ).rows[0];
  if (!venue) throw new Error("no West 4 here: run pnpm seed first");
  const inVenue = <T>(work: (c: Queryable) => Promise<T>) =>
    withVenue(owner, { venueId: venue.id, requestId: "ops:stripe:seed" }, work);

  let account = venue.account;
  if (account) {
    const known = await retrieveAccount(stripe, account)
      .then(() => true)
      .catch((e: unknown) =>
        e instanceof StripeError && e.status === 404 ? false : Promise.reject(e),
      );
    if (!known) {
      if (stripe.settings.mode !== "fake")
        throw new Error(
          `organization ${venue.org_id} holds Stripe account ${account}, which this Stripe doesn't know; clear organizations.stripe_account_id to make a new one`,
        );
      await owner.query("update organizations set stripe_account_id = null where id = $1", [
        venue.org_id,
      ]);
      account = null;
    }
  }
  if (!account) {
    const owners = await owner.query<{ email: string | null }>(
      `select u.email from memberships m join users u on u.id = m.user_id
        where m.venue_id = $1 and m.role = 'owner' and m.status = 'active' limit 1`,
      [venue.id],
    );
    account = (
      await createAccountFor(
        owner,
        stripe,
        venue.org_id,
        owners.rows[0]?.email ?? "owner@demo.west4.local",
      )
    ).accountId;
    log(`stripe: made account ${account}`);
  }

  // The demo night's settings (its simulated clock, never the device's).
  const today = businessDate(SEED_NOW, venue.time_zone, venue.day_cutover).businessDate;
  const terminal = await ensureTerminal(inVenue, stripe, venue.id, today);
  const atStripe = await listReaders(stripe, terminal.account, terminal.locationId);
  let readers = 0;
  for (const r of await inVenue((c) => venueReaders(c, venue.id))) {
    let reader = atStripe.find((x) => x.label === r.name);
    if (!reader)
      reader = await registerReader(
        stripe,
        terminal.account,
        { registrationCode: "simulated-s710", label: r.name, location: terminal.locationId },
        `seed:${venue.id}:reader:${r.name}:${Date.now()}`,
      );
    const model = readerModel(reader.device_type, stripe.livemode);
    if (!model) continue;
    await inVenue((c) =>
      saveReader(c, venue.id, {
        name: r.name,
        stripeReaderId: reader.id,
        model,
        cellular: hasCellular(model),
      }),
    );
    readers += 1;
  }

  const deposits = await owner.query<{
    id: string;
    amount_cents: string;
    card_brand: string | null;
    booking_id: string;
    name: string | null;
  }>(
    `select p.id, p.amount_cents, p.card_brand, p.booking_id,
            (select g.name from bookings b join guests g on g.venue_id = b.venue_id and g.id = b.guest_id
              where b.venue_id = p.venue_id and b.id = p.booking_id) as name
       from payments p where p.venue_id = $1 and p.method = 'card_online' and p.booking_id is not null
        and p.stripe_pi_id is null and p.status = 'captured'
      order by p.created_at, p.id`,
    [venue.id],
  );
  for (const d of deposits.rows) {
    const customer = await stripe.call<{ id: string }>("payments", "POST", "/v1/customers", {
      account: terminal.account,
      idempotencyKey: `${d.id}:customer`,
      params: { name: d.name ?? "Guest", metadata: { booking_id: d.booking_id } },
    });
    const pi = await stripe.call<{ id: string; status: string }>(
      "payments",
      "POST",
      "/v1/payment_intents",
      {
        account: terminal.account,
        idempotencyKey: `${d.id}:create`,
        params: {
          amount: Number(d.amount_cents),
          currency: "usd",
          customer: customer.id,
          payment_method: TEST_PM[d.card_brand ?? "visa"] ?? "pm_card_visa",
          payment_method_types: ["card"],
          confirm: true,
          setup_future_usage: "off_session",
          metadata: { payment_id: d.id, booking_id: d.booking_id },
        },
      },
    );
    if (pi.status !== "succeeded")
      throw new Error(`deposit ${d.id}: PaymentIntent ${pi.id} is ${pi.status}`);
    await inVenue((c) => setPaymentIntent(c, d.id, pi.id));
  }
  log(
    `stripe: account ${account}, ${readers} readers, ${deposits.rows.length} deposits backed by PaymentIntents`,
  );
  return { account, readers, deposits: deposits.rows.length };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const settings = loadStripeSettings(config.env);
  if (settings.mode === "off") {
    console.warn("stripe:seed: no Stripe here (no keys and no fake); skipped");
    return;
  }
  const owner = new pg.Pool({
    connectionString: process.env["DATABASE_URL"] ?? config.databaseUrl,
  });
  try {
    await seedStripe(owner, new StripeClient(settings));
  } catch (e) {
    if (e instanceof Error && /no answer from Stripe/.test(e.message)) {
      console.warn("stripe:seed: Stripe (or the fake) isn't answering; skipped");
      return;
    }
    throw e;
  } finally {
    await owner.end();
  }
}

if (process.argv[1]?.endsWith("seed-stripe.ts") || process.argv[1]?.endsWith("seed-stripe.js"))
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
