import {
  databaseUrl,
  readSetting,
  saveReader,
  setPaymentIntent,
  venueReaders,
  withVenue,
  type Queryable,
} from "@west4/db";
import { businessDate } from "@west4/rules";
import { SEED_NOW } from "@west4/shared";
import pg from "pg";
import { loadConfig } from "../config.js";
import type { StripeClient } from "./client.js";
import { StripeError, stripeFromEnv } from "./client.js";
import { retrieveAccount } from "./accounts.js";
import { createAccountFor, createTrainingAccountFor } from "./create-account.js";
import { loadStripeSettings } from "./settings.js";
import { observeIntent, registerPayDomain, retrieveIntent } from "./payments.js";
import { confirmOnReader } from "./surcharge.js";
import {
  collectForTab,
  createTabCustomer,
  createTabIntent,
  incrementHold,
  retrieveCollectedCard,
} from "./tabs.js";
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
 *    brand and last four for display (Stripe's test Amex ends in 0005);
 *  - every held bar tab without a PaymentIntent (the five open tabs and the
 *    paper slips, M6-27) backed by a real hold: a manual-capture
 *    PaymentIntent asking for incremental authorization, its card tapped on
 *    the simulated bar reader (Stripe's test card of the brand) and
 *    confirmed, Luis M.'s and Tariq A.'s raised from the opening hold, and the
 *    card's fingerprint and saved card kept, so Send grows the hold, closing
 *    and entering the tip capture on it, and the same card reopens its tab.
 * Nothing runs in live mode, and nothing runs inside a transaction.
 */
/** Stripe's test card numbers a simulated reader takes, by brand. */
const TEST_CARD: Record<string, string> = {
  amex: "378282246310005",
  visa: "4242424242424242",
  mastercard: "5555555555554444",
  discover: "6011111111111117",
};

const TEST_PM: Record<string, string> = {
  amex: "pm_card_amex",
  visa: "pm_card_visa",
  mastercard: "pm_card_mastercard",
  discover: "pm_card_discover",
};

/**
 * The card each seed tab is tapped with (M6-27). The fake reads any number, so it gets the brand's test-card
 * prefix, zeros and the seed's last four (4242 4200 0000 4417 for Jess P.): every tab its own fingerprint,
 * and none the same as a card the tests tap to open a new tab. A sandbox takes only Stripe's own test cards, and the same card always reads
 * as the same fingerprint, so each card goes to one tab only; a tab left without a card of its own is
 * tapped with the brand's first and carries no fingerprint (two open tabs can't hold one card).
 */
const SANDBOX_CARDS: Record<string, readonly string[]> = {
  visa: ["4242424242424242", "4000056655665556"],
  mastercard: ["5555555555554444", "2223003122003222", "5200828282828210"],
  amex: ["378282246310005", "371449635398431"],
  discover: ["6011111111111117", "6011000990139424"],
};

export function tabCards(fake: boolean) {
  const used = new Map<string, number>();
  return (brandName: string, last4: string | null): { number: string; fingerprint: boolean } => {
    const brand = brandName.toLowerCase();
    const first = TEST_CARD[brand] ?? TEST_CARD["visa"]!;
    if (fake)
      return {
        number: last4 ? `${first.slice(0, 6)}${"0".repeat(first.length - 10)}${last4}` : first,
        fingerprint: true,
      };
    const n = used.get(brand) ?? 0;
    used.set(brand, n + 1);
    const own = (SANDBOX_CARDS[brand] ?? [])[n];
    return { number: own ?? first, fingerprint: own !== undefined };
  };
}

export async function seedStripe(
  owner: pg.Pool,
  stripe: StripeClient,
  log: (line: string) => void = (l) => console.warn(l),
): Promise<{ account: string; readers: number; deposits: number; holds: number }> {
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
  for (const r of (await inVenue((c) => venueReaders(c, venue.id))).filter((x) => !x.sandbox)) {
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
  // The held bar tabs (M6-27): the five open tabs and the three paper slips, each opened the way the bar's
  // New tab opens one: a manual-capture PaymentIntent asking for incremental authorization, its card tapped
  // on the simulated bar reader and confirmed. A tab whose hold grew (Luis M.'s to $80.00, Tariq A.'s to $100.00) opens at the venue's
  // opening hold and is raised to its hold, as Send does. The card's fingerprint goes on the tab, so
  // tapping the same card at New tab opens that tab again.
  const openingHold =
    (await inVenue((c) => readSetting(c, venue.id, "tabs", today)))?.value.openingHoldCents ?? 0;
  const holds = await owner.query<{
    id: string;
    tab_id: string;
    authorized_cents: number;
    increments_used: number;
    card_brand: string | null;
    card_last4: string | null;
  }>(
    `select p.id, t.id as tab_id, p.authorized_cents::int as authorized_cents, p.increments_used,
            p.card_brand, p.card_last4
       from payments p join tabs t on t.venue_id = p.venue_id and t.payment_id = p.id
      where p.venue_id = $1 and p.method = 'card_present' and p.status = 'authorized' and p.stripe_pi_id is null
      order by t.state = 'open' desc, t.opened_at, p.id`,
    [venue.id],
  );
  const bar = (await inVenue((c) => venueReaders(c, venue.id))).find(
    (r) => r.name === "Bar S710" && r.stripe_reader_id && !r.sandbox,
  );
  if (holds.rows.length > 0 && !bar) throw new Error("no Bar S710 to tap the tabs' cards on");
  const cards = tabCards(stripe.settings.mode === "fake");
  for (const h of holds.rows) {
    const readerId = bar!.stripe_reader_id!;
    const card = cards(h.card_brand ?? "visa", h.card_last4);
    const grew = h.increments_used > 0 && openingHold > 0 && h.authorized_cents > openingHold;
    const customer = await createTabCustomer(stripe, terminal.account, h.id);
    const pi = await createTabIntent(stripe, terminal.account, {
      amountCents: grew ? openingHold : h.authorized_cents,
      paymentId: h.id,
      customer: customer.id,
    });
    await collectForTab(
      stripe,
      terminal.account,
      { readerId, piId: pi.id },
      `${h.id}:seed:collect`,
    );
    await stripe.call(
      "payments",
      "POST",
      `/v1/test_helpers/terminal/readers/${encodeURIComponent(readerId)}/present_payment_method`,
      {
        account: terminal.account,
        idempotencyKey: `${h.id}:seed:present`,
        params: { card_present: { number: card.number } },
      },
    );
    await confirmOnReader(
      stripe,
      terminal.account,
      { readerId, piId: pi.id },
      `${h.id}:seed:confirm`,
    );
    if (grew)
      await incrementHold(
        stripe,
        terminal.account,
        { piId: pi.id, targetCents: h.authorized_cents },
        `${h.id}:seed:increment:${h.authorized_cents}`,
      );
    const held = observeIntent(await retrieveIntent(stripe, terminal.account, pi.id));
    if (held.status !== "requires_capture")
      throw new Error(`tab hold ${h.id}: PaymentIntent ${pi.id} is ${held.status}`);
    if ((held.amountCapturable ?? 0) !== h.authorized_cents)
      throw new Error(
        `tab hold ${h.id}: PaymentIntent ${pi.id} holds ${held.amountCapturable}, not ${h.authorized_cents}`,
      );
    const collected = card.fingerprint
      ? await retrieveCollectedCard(stripe, terminal.account, pi.id)
      : null;
    await inVenue(async (c) => {
      await setPaymentIntent(c, h.id, pi.id);
      await c.query(
        `update payments set incremental_supported = $2, overcapture_supported = $3, capture_before = $4,
                generated_card_pm = $5
          where id = $1`,
        [
          h.id,
          held.hold?.incrementalSupported ?? null,
          held.hold?.overcaptureSupported ?? null,
          held.hold?.captureBefore ?? null,
          held.card?.generatedCard ?? null,
        ],
      );
      // Our rows keep the seed's brand and last four for display, over Stripe's test card of the brand.
      if (collected?.fingerprint)
        await c.query("update tabs set card_fingerprint = $2 where id = $1", [
          h.tab_id,
          collected.fingerprint,
        ]);
    });
  }
  // The payment page's own hostname, for Apple Pay and Google Pay (M4-15). Local hosts can't be registered.
  const payDomain = process.env["PAY_DOMAIN"];
  if (payDomain && !/localhost$/.test(payDomain)) {
    await registerPayDomain(stripe, terminal.account, payDomain);
    log(`stripe: ${payDomain} registered for wallets`);
  }
  log(
    `stripe: account ${account}, ${readers} readers, ${deposits.rows.length} deposits and ${holds.rows.length} tab holds backed by PaymentIntents`,
  );
  return { account, readers, deposits: deposits.rows.length, holds: holds.rows.length };
}

/**
 * Training mode's side (M7-04): West 4's sandbox account (kept across
 * reloads like the live one), its sandbox Terminal Location, and a simulated
 * "Bar S710" and "Front desk S710" on it, the readers a screen in training
 * picks from. Skipped when this environment has no sandbox.
 */
export async function seedTrainingStripe(
  owner: pg.Pool,
  stripe: StripeClient,
  log: (line: string) => void = (l) => console.warn(l),
): Promise<{ account: string; readers: number } | null> {
  const sandbox = stripe.sandboxSettings;
  if (!sandbox || sandbox.mode === "off") return null;
  const practice = stripe.forTraining(true);
  const venue = (
    await owner.query<{
      id: string;
      org_id: string;
      time_zone: string;
      day_cutover: string;
      account: string | null;
    }>(
      `select v.id, v.org_id, v.time_zone, to_char(v.day_cutover, 'HH24:MI') as day_cutover,
              o.stripe_training_account_id as account
         from venues v join organizations o on o.id = v.org_id where v.slug = 'west4karaoke'`,
    )
  ).rows[0];
  if (!venue) throw new Error("no West 4 here: run pnpm seed first");
  const inVenue = <T>(work: (c: Queryable) => Promise<T>) =>
    withVenue(owner, { venueId: venue.id, requestId: "ops:stripe:seed:training" }, work);
  let account = venue.account;
  if (account) {
    const known = await retrieveAccount(practice, account)
      .then(() => true)
      .catch((e: unknown) =>
        e instanceof StripeError && (e.status === 404 || e.status === 403)
          ? false
          : Promise.reject(e),
      );
    if (!known) {
      if (sandbox.mode !== "fake")
        throw new Error(
          `organization ${venue.org_id} holds sandbox account ${account}, which the sandbox doesn't know; clear organizations.stripe_training_account_id to make a new one`,
        );
      await owner.query(
        "update organizations set stripe_training_account_id = null where id = $1",
        [venue.org_id],
      );
      account = null;
    }
  }
  if (!account) {
    account = (await createTrainingAccountFor(owner, stripe, venue.org_id)).accountId;
    log(`stripe: made sandbox account ${account}`);
  }
  const today = businessDate(SEED_NOW, venue.time_zone, venue.day_cutover).businessDate;
  const terminal = await ensureTerminal(inVenue, stripe, venue.id, today, true);
  const atStripe = await listReaders(practice, terminal.account, terminal.locationId);
  const all = await inVenue((c) => venueReaders(c, venue.id));
  const labels = [...new Set(all.filter((r) => !r.sandbox).map((r) => r.name))];
  let readers = 0;
  for (const label of labels) {
    const reader =
      atStripe.find((x) => x.label === label) ??
      (await registerReader(
        practice,
        terminal.account,
        { registrationCode: "simulated-s710", label, location: terminal.locationId },
        `seed:${venue.id}:training-reader:${label}:${Date.now()}`,
      ));
    const model = readerModel(reader.device_type, false);
    if (!model) continue;
    await inVenue((c) =>
      saveReader(c, venue.id, {
        name: label,
        stripeReaderId: reader.id,
        model,
        cellular: hasCellular(model),
        sandbox: true,
      }),
    );
    readers += 1;
  }
  log(`stripe: sandbox account ${account}, ${readers} simulated readers for training mode`);
  return { account, readers };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const settings = loadStripeSettings(config.env);
  if (settings.mode === "off") {
    console.warn("stripe:seed: no Stripe here (no keys and no fake); skipped");
    return;
  }
  const owner = new pg.Pool({
    // The table owner (DATABASE_URL, or the DB_* parts ECS injects), never the API's app_rw.
    connectionString: databaseUrl(),
  });
  try {
    const stripe = stripeFromEnv(config.env);
    await seedStripe(owner, stripe);
    await seedTrainingStripe(owner, stripe);
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
