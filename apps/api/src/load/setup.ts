import { webcrypto } from "node:crypto";
import type pg from "pg";
import { openSession, pinVerifier, saveReader, withVenue, type Queryable } from "@west4/db";
import { businessDate } from "@west4/rules";
import { DEVICE_KEY_ALGORITHM, Temporal } from "@west4/shared";
import type { StripeClient } from "../stripe/client.js";
import { hasCellular, readerModel, registerReader } from "../stripe/terminal.js";
import { ensureTerminal } from "../stripe/terminal-setup.js";
import { SYNTHETIC_FLAG } from "../ops/synthetic.js";

/**
 * The venues a Friday-night load test runs on (M8-21; spec 13 · Tests). Each is generated: its own
 * organization, a copy of the template venue's settings, modules and rooms (the demo seed's West 4,
 * read only), a soda on the menu, a bartender with a PIN, an owner signed in for the reports, a bar
 * computer in training mode with a fresh key, and two simulated readers on the organization's own
 * Stripe sandbox. Everything is practice, and the `load.test_venue` flag marks the venue. It never
 * writes to the template, and it refuses production.
 */
export const LOAD_FLAG = "load.test_venue";

export interface LoadVenue {
  readonly venueId: string;
  readonly slug: string;
  readonly deviceId: string;
  readonly deviceKey: webcrypto.JsonWebKey;
  readonly bartender: { readonly membershipId: string; readonly pin: string };
  /** An owner's session, for the reports (owner_manager, as after a passkey: Admin asks for one). */
  readonly ownerToken: string;
  readonly rooms: readonly string[];
  readonly sodaVariant: string;
  readonly readers: readonly string[];
  /** The readers on Stripe (the same order), and the sandbox account they're on. */
  readonly stripeReaders: readonly string[];
  readonly stripeAccount: string;
}

export interface LoadConfig {
  readonly apiUrl: string;
  readonly venues: readonly LoadVenue[];
}

export class LoadRefused extends Error {}

/** The API's own "now" (the simulated clock while one runs), from its X-Server-Time header. */
export async function serverNow(apiUrl: string): Promise<Temporal.Instant> {
  const res = await fetch(`${apiUrl.replace(/\/+$/, "")}/v1/health`);
  const at = res.headers.get("x-server-time");
  if (!res.ok || !at) throw new LoadRefused(`the API at ${apiUrl} didn't answer its health check`);
  return Temporal.Instant.from(at);
}

export async function setupLoadVenues(
  owner: pg.Pool,
  stripe: StripeClient,
  args: {
    readonly env: string;
    readonly apiUrl: string;
    readonly count: number;
    readonly templateSlug: string;
    readonly prefix: string;
    readonly authKey: Buffer;
    /** The API's now: sessions and the business date follow its clock. */
    readonly now: Temporal.Instant;
  },
): Promise<LoadConfig> {
  if (args.env === "production") throw new LoadRefused("a load test never runs in production");
  if (!/^[a-z0-9-]{1,30}$/.test(args.prefix)) throw new LoadRefused("the prefix is a-z, 0-9 and -");
  const template = (
    await owner.query<{ id: string; time_zone: string; day_cutover: string }>(
      "select id, time_zone, to_char(day_cutover, 'HH24:MI') as day_cutover from venues where slug = $1",
      [args.templateSlug],
    )
  ).rows[0];
  if (!template)
    throw new LoadRefused(`no template venue ${args.templateSlug}: load the demo seed`);
  const now = args.now;
  const today = businessDate(now, template.time_zone, template.day_cutover).businessDate;
  const one = async <T extends pg.QueryResultRow>(sql: string, params: unknown[]) =>
    (await owner.query<T>(sql, params)).rows[0]!;

  const venues: LoadVenue[] = [];
  for (let i = 1; i <= args.count; i++) {
    const n = String(i).padStart(2, "0");
    const slug = `${args.prefix}-${n}`;
    if ((await owner.query("select 1 from venues where slug = $1", [slug])).rowCount)
      throw new LoadRefused(`${slug} exists: pick a new --prefix (each run makes its own venues)`);
    const org = await one<{ id: string }>(
      "insert into organizations (legal_name) values ($1) returning id",
      [`Load test ${args.prefix} ${n}`],
    );
    const venueId = (
      await one<{ id: string }>(
        `insert into venues (org_id, name, slug, address, time_zone, day_cutover, rule_pack_id)
         select $1, $2, $3, address, time_zone, day_cutover, rule_pack_id from venues where id = $4
         returning id`,
        [org.id, `Load test ${n}`, slug, template.id],
      )
    ).id;
    await owner.query(
      `insert into venue_settings (venue_id, key, version, value, saved_by, starts_on)
       select $1, key, version, value, saved_by, starts_on from venue_settings where venue_id = $2`,
      [venueId, template.id],
    );
    await owner.query(
      `insert into venue_modules (venue_id, module_id, allowed, state)
       select $1, module_id, allowed, state from venue_modules where venue_id = $2`,
      [venueId, template.id],
    );
    // Our own test venue (the synthetic check's marker: a practice room session can be joined, and
    // the venue never counts as live), and a load test's.
    await owner.query(
      `insert into venue_flags (venue_id, flag, "on", set_by)
       select $1, f, true, 'load test' from unnest($2::text[]) f`,
      [venueId, [SYNTHETIC_FLAG, LOAD_FLAG]],
    );
    const rooms = (
      await owner.query<{ id: string }>(
        `insert into rooms (venue_id, name, size_tier, capacity_min, capacity_max)
         select $1, name, size_tier, capacity_min, capacity_max from rooms
          where venue_id = $2 and archived_at is null order by name returning id`,
        [venueId, template.id],
      )
    ).rows.map((r) => r.id);
    const cat = await one<{ id: string }>(
      "insert into menu_categories (venue_id, name, tax_category) values ($1, 'Soft drinks', 'drink') returning id",
      [venueId],
    );
    const item = await one<{ id: string }>(
      "insert into menu_items (venue_id, category_id, name, alcohol) values ($1, $2, 'Club soda', false) returning id",
      [venueId, cat.id],
    );
    const sodaVariant = (
      await one<{ id: string }>(
        "insert into menu_variants (venue_id, item_id, name, price_cents) values ($1, $2, 'Regular', 300) returning id",
        [venueId, item.id],
      )
    ).id;
    const person = async (name: string, role: string) => {
      const u = await one<{ id: string }>("insert into users (name) values ($1) returning id", [
        name,
      ]);
      const m = await one<{ id: string }>(
        `insert into memberships (venue_id, user_id, role, status, pin_digits, locale)
         values ($1, $2, $3, 'active', 4, 'en') returning id`,
        [venueId, u.id, role],
      );
      return { userId: u.id, membershipId: m.id };
    };
    const boss = await person(`Load owner ${n}`, "owner");
    const bar = await person(`Load bartender ${n}`, "bartender");
    const pin = String(1000 + Math.floor(Math.random() * 9000));
    await owner.query("update memberships set pin_verifier = $2 where id = $1", [
      bar.membershipId,
      await pinVerifier(args.authKey, venueId, bar.membershipId, pin),
    ]);
    const session = await openSession(owner, {
      principal: "owner_manager",
      userId: boss.userId,
      assurance: "passkey",
      client: "web",
      startedAt: now.toString(),
      expiresAt: now.add({ hours: 12 }).toString(),
    });

    // The bar computer, in training (practice), with a fresh key held only by the harness.
    const key = await webcrypto.subtle.generateKey(DEVICE_KEY_ALGORITHM, true, ["sign", "verify"]);
    const deviceId = (
      await one<{ id: string }>(
        `insert into devices (venue_id, kind, name, public_key, training)
         values ($1, 'bar_computer', 'Load bar', $2, true) returning id`,
        [venueId, JSON.stringify(await webcrypto.subtle.exportKey("jwk", key.publicKey))],
      )
    ).id;

    // The organization's sandbox and two simulated readers on it, as Admin → Devices would.
    const account = await stripe
      .forTraining(true)
      .call<{ id: string }>("payments", "POST", "/v2/core/accounts", {
        account: null,
        platform: true,
        idempotencyKey: `load-acct-${venueId}`,
        params: { display_name: `Load test ${n}` },
      });
    await owner.query("update organizations set stripe_training_account_id = $1 where id = $2", [
      account.id,
      org.id,
    ]);
    const inVenue = <T>(fn: (c: Queryable) => Promise<T>) =>
      withVenue(owner, { venueId, requestId: "load-setup" }, fn);
    const terminal = await ensureTerminal(inVenue, stripe, venueId, today, true);
    const readers: string[] = [];
    const stripeReaders: string[] = [];
    for (const label of ["Load S710 A", "Load S710 B"]) {
      const reader = await registerReader(
        stripe.forTraining(true),
        terminal.account,
        { registrationCode: "simulated-s710", label, location: terminal.locationId },
        `load-reader-${venueId}-${label}`,
      );
      const model = readerModel(reader.device_type, false);
      if (!model) throw new Error(`unexpected simulated reader ${reader.device_type}`);
      stripeReaders.push(reader.id);
      readers.push(
        await inVenue((c) =>
          saveReader(c, venueId, {
            name: label,
            stripeReaderId: reader.id,
            model,
            cellular: hasCellular(model),
            sandbox: true,
          }),
        ),
      );
    }
    venues.push({
      venueId,
      slug,
      deviceId,
      deviceKey: await webcrypto.subtle.exportKey("jwk", key.privateKey),
      bartender: { membershipId: bar.membershipId, pin },
      ownerToken: session.token,
      rooms,
      sodaVariant,
      readers,
      stripeReaders,
      stripeAccount: terminal.account,
    });
  }
  return { apiUrl: args.apiUrl, venues };
}

/** Stripe's test cards that read as different cards (card_present), one per tab. */
export const TEST_CARDS = [
  "4242424242424242",
  "4000056655665556",
  "5555555555554444",
  "2223003122003222",
  "5200828282828210",
  "5105105105105100",
  "378282246310005",
  "371449635398431",
  "6011111111111117",
  "6011000990139424",
  "3566002020360505",
  "6200000000000005",
] as const;

/**
 * Presents a test card on a load venue's simulated reader, as a guest's card at the bar: Stripe's
 * own test helper on the sandbox (the fake in a load test), so each tab can be a different card.
 */
export function cardPresenter(stripe: StripeClient) {
  return async (venue: LoadVenue, reader: number, card: string, key: string): Promise<void> => {
    await stripe
      .forTraining(true)
      .call(
        "payments",
        "POST",
        `/v1/test_helpers/terminal/readers/${encodeURIComponent(venue.stripeReaders[reader]!)}/present_payment_method`,
        {
          account: venue.stripeAccount,
          idempotencyKey: `load-card-${key}`,
          params: { type: "card_present", card_present: { number: card } },
        },
      );
  };
}
