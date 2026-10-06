import { createHash } from "node:crypto";
import {
  checkIsTraining,
  emitEvent,
  readerOfVenue,
  stripeAccountFor,
  withVenue,
  type Queryable,
} from "@west4/db";
import { roomCardConsentLine, type Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { NoSuchReader, ReaderQuiet, quiet, type PaymentDeps } from "../payments/run.js";
import { StripeError } from "../stripe/client.js";
import {
  cancelReaderAction,
  cancelRoomSetupIntent,
  createRoomCustomer,
  createRoomSetupIntent,
  processRoomSetupIntent,
  readerAction,
  retrieveRoomSetupIntent,
  type StripeSetupIntent,
} from "../stripe/room-card.js";
import { releaseMovedHolds, roomHasCard } from "../tabs/move.js";

/**
 * A card tapped for a room (M6-13; Payment flows · Moving a tab into a room): for a walk-in with no
 * saved card, such as Room 5, the reader saves a card through a SetupIntent (`process_setup_intent`)
 * without charging it, after the bartender reads the guest the consent line, stored with who read it and
 * its version (a `policy_versions` row, kind `room_card_consent`), as for a tab. Once it's saved, the
 * holds of tabs moved into the room are canceled (Money rules 12).
 *   1. Start (a transaction): the room's check, the reader and the consent are checked and a
 *      `check_cards` row is written, `waiting`.
 *   2. Outside it: a Customer, the SetupIntent, and `process_setup_intent` on the reader.
 *   3. Check status (the screen polls each second): the SetupIntent succeeded → `saved`, with the
 *      generated card, and the moved holds released; a decline or the reader giving up → `failed`.
 */
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export async function roomCardConsent(c: Queryable, venueId: string, now: Temporal.Instant) {
  const text = roomCardConsentLine();
  const hash = sha256(text);
  await c.query("select pg_advisory_xact_lock(hashtext('room_card_consent:' || $1::text))", [
    venueId,
  ]);
  const latest = (
    await c.query<{ id: string; version: number; hash: string }>(
      `select id, version, hash from policy_versions where venue_id = $1 and kind = 'room_card_consent'
        order by version desc limit 1`,
      [venueId],
    )
  ).rows[0];
  if (latest && latest.hash === hash)
    return { version_id: latest.id, version: latest.version, text };
  const version = (latest?.version ?? 0) + 1;
  const id = (
    await c.query<{ id: string }>(
      `insert into policy_versions (venue_id, kind, version, text, hash, published_at)
       values ($1, 'room_card_consent', $2, $3, $4, $5) returning id`,
      [venueId, version, text, hash, now.toString()],
    )
  ).rows[0]!.id;
  return { version_id: id, version, text };
}

interface CardRow {
  readonly id: string;
  readonly check_id: string;
  readonly stripe_reader_id: string;
  readonly state: "waiting" | "saved" | "failed" | "canceled";
  readonly stripe_customer_id: string | null;
  readonly stripe_setup_intent_id: string | null;
  readonly card_brand: string | null;
  readonly card_last4: string | null;
  readonly failure_code: string | null;
}

async function cardRow(c: Queryable, venueId: string, id: string, lock = false) {
  const r = await c.query<CardRow>(
    `select id, check_id, stripe_reader_id, state, stripe_customer_id, stripe_setup_intent_id, card_brand,
            card_last4, failure_code
       from check_cards where venue_id = $1 and id = $2${lock ? " for update" : ""}`,
    [venueId, id],
  );
  return r.rows[0] ?? null;
}

export const cardView = (row: CardRow) => ({
  id: row.id,
  check_id: row.check_id,
  state: row.state,
  card: row.card_last4 ? { brand: row.card_brand, last4: row.card_last4 } : null,
  failure_code: row.failure_code,
});

/** The tap of a room's check, found by both ids (a route's check and tap). */
export async function roomCardOf(c: Queryable, venueId: string, checkId: string, id: string) {
  const row = await cardRow(c, venueId, id);
  if (!row || row.check_id !== checkId) throw new ApiError("not_found", "no such card tap");
  return row;
}

/** Step 1, in the caller's transaction. */
export async function startRoomCard(
  c: Queryable,
  venueId: string,
  input: {
    checkId: string;
    readerDeviceId: string;
    consentVersionId: string;
    userId: string;
    now: Temporal.Instant;
  },
): Promise<CardRow> {
  const check = (
    await c.query<{ kind: string; status: string }>(
      "select kind, status from checks where venue_id = $1 and id = $2 for update",
      [venueId, input.checkId],
    )
  ).rows[0];
  if (!check) throw new ApiError("not_found", "no such check");
  if (check.kind !== "room" || ["paid", "void"].includes(check.status))
    throw new ApiError("invalid_request", "a card is saved for a room that's still open", {
      details: { reason: "not_a_room" },
    });
  if (await roomHasCard(c, venueId, input.checkId))
    throw new ApiError("invalid_request", "this room already has a card", {
      details: { reason: "has_card" },
    });
  const consent = await c.query(
    "select 1 from policy_versions where venue_id = $1 and id = $2 and kind = 'room_card_consent'",
    [venueId, input.consentVersionId],
  );
  if (!consent.rowCount)
    throw new ApiError("invalid_request", "read the guest the consent line first", {
      details: { reason: "consent" },
    });
  const reader = await readerOfVenue(
    c,
    venueId,
    input.readerDeviceId,
    await checkIsTraining(c, venueId, input.checkId),
  );
  if (!reader) throw new NoSuchReader();
  if (await quiet(c, venueId, input.readerDeviceId, input.now)) throw new ReaderQuiet();
  const waiting = await c.query<{ id: string }>(
    "select id from check_cards where venue_id = $1 and check_id = $2 and state = 'waiting'",
    [venueId, input.checkId],
  );
  if (waiting.rows[0])
    throw new ApiError("in_progress", "a card is being tapped for this room", {
      details: { card_tap_id: waiting.rows[0].id },
    });
  const r = await c.query<{ id: string }>(
    `insert into check_cards (venue_id, check_id, reader_device_id, stripe_reader_id, state,
       consent_text_version, consent_read_by, started_by, started_at)
     values ($1, $2, $3, $4, 'waiting', $5, $6, $6, $7) returning id`,
    [
      venueId,
      input.checkId,
      input.readerDeviceId,
      reader.stripe_reader_id,
      input.consentVersionId,
      input.userId,
      input.now.toString(),
    ],
  );
  return (await cardRow(c, venueId, r.rows[0]!.id))!;
}

const inVenue = <T>(deps: PaymentDeps, venueId: string, work: (c: Queryable) => Promise<T>) =>
  withVenue(deps.pool, { venueId, requestId: "room-card" }, work);

async function fail(deps: PaymentDeps, venueId: string, id: string, code: string) {
  return inVenue(deps, venueId, async (c) => {
    await c.query(
      `update check_cards set state = 'failed', failure_code = $3, settled_at = $4
        where venue_id = $1 and id = $2 and state = 'waiting'`,
      [venueId, id, code, deps.clock.now().toString()],
    );
    return (await cardRow(c, venueId, id))!;
  });
}

/** Step 2, outside any transaction: the Customer, the SetupIntent, and the reader asking for the card. */
export async function driveRoomCard(deps: PaymentDeps, venueId: string, id: string) {
  const { row, account, training } = await inVenue(deps, venueId, async (c) => {
    const row = await cardRow(c, venueId, id);
    // A practice room's card is saved on the sandbox, from a simulated reader (M7-04).
    const training = row ? await checkIsTraining(c, venueId, row.check_id) : false;
    return { row, training, account: await stripeAccountFor(c, venueId, training) };
  });
  deps = { ...deps, stripe: deps.stripe.forTraining(training) };
  if (!row || row.state !== "waiting") return row;
  if (!account) return fail(deps, venueId, id, "no_stripe_account");
  try {
    const customer =
      row.stripe_customer_id ?? (await createRoomCustomer(deps.stripe, account, id)).id;
    const si =
      row.stripe_setup_intent_id ??
      (
        await createRoomSetupIntent(deps.stripe, account, {
          tapId: id,
          customer,
          checkId: row.check_id,
        })
      ).id;
    await inVenue(deps, venueId, (c) =>
      c.query(
        `update check_cards set stripe_customer_id = $3, stripe_setup_intent_id = $4
          where venue_id = $1 and id = $2`,
        [venueId, id, customer, si],
      ),
    );
    await processRoomSetupIntent(deps.stripe, account, {
      tapId: id,
      readerId: row.stripe_reader_id,
      setupIntent: si,
    });
  } catch (e) {
    if (e instanceof StripeError) return fail(deps, venueId, id, e.code ?? "stripe_error");
    throw e;
  }
  return inVenue(deps, venueId, (c) => cardRow(c, venueId, id));
}

/** The card the SetupIntent saved: the generated card from the tap, with its brand and last four. */
function savedOf(si: StripeSetupIntent) {
  const attempt = typeof si.latest_attempt === "object" ? si.latest_attempt : null;
  const present = attempt?.payment_method_details?.card_present;
  const pm =
    present?.generated_card ??
    (typeof si.payment_method === "string" ? si.payment_method : (si.payment_method?.id ?? null));
  return { pm, brand: present?.brand ?? null, last4: present?.last4 ?? null };
}

async function save(deps: PaymentDeps, venueId: string, id: string, si: StripeSetupIntent) {
  const card = savedOf(si);
  const now = deps.clock.now();
  return inVenue(deps, venueId, async (c) => {
    const row = await cardRow(c, venueId, id, true);
    if (!row || row.state === "saved") return row;
    await c.query(
      `update check_cards set state = 'saved', stripe_payment_method_id = $3, card_brand = $4,
         card_last4 = $5, failure_code = null, settled_at = $6
        where venue_id = $1 and id = $2`,
      [venueId, id, card.pm, card.brand, card.last4, now.toString()],
    );
    // The room has a payment method: the holds of tabs moved into it are canceled.
    await releaseMovedHolds(c, venueId, row.check_id, now);
    await emitEvent(c, {
      venueId,
      type: "check.updated",
      entityId: row.check_id,
      entityVersion: 0,
    });
    return cardRow(c, venueId, id);
  });
}

/** Step 3: what the reader and the SetupIntent say now. */
export async function checkRoomCard(deps: PaymentDeps, venueId: string, id: string) {
  const { row, account, training } = await inVenue(deps, venueId, async (c) => {
    const row = await cardRow(c, venueId, id);
    // A practice room's card is saved on the sandbox, from a simulated reader (M7-04).
    const training = row ? await checkIsTraining(c, venueId, row.check_id) : false;
    return { row, training, account: await stripeAccountFor(c, venueId, training) };
  });
  deps = { ...deps, stripe: deps.stripe.forTraining(training) };
  if (!row || row.state !== "waiting" || !account) return row;
  if (!row.stripe_setup_intent_id) return driveRoomCard(deps, venueId, id);
  const si = await retrieveRoomSetupIntent(deps.stripe, account, row.stripe_setup_intent_id);
  if (si.status === "succeeded") return save(deps, venueId, id, si);
  if (si.last_setup_error)
    return fail(
      deps,
      venueId,
      id,
      si.last_setup_error.decline_code ?? si.last_setup_error.code ?? "card_declined",
    );
  const action = await readerAction(deps.stripe, account, row.stripe_reader_id);
  if (action?.type === "process_setup_intent" && action.status === "failed")
    return fail(deps, venueId, id, action.failure_code ?? "reader_failed");
  return row;
}

/** Staff cancel the tap: the reader stops asking and the SetupIntent is canceled, unless it was saved. */
export async function cancelRoomCard(deps: PaymentDeps, venueId: string, id: string) {
  const { row, account, training } = await inVenue(deps, venueId, async (c) => {
    const row = await cardRow(c, venueId, id);
    // A practice room's card is saved on the sandbox, from a simulated reader (M7-04).
    const training = row ? await checkIsTraining(c, venueId, row.check_id) : false;
    return { row, training, account: await stripeAccountFor(c, venueId, training) };
  });
  deps = { ...deps, stripe: deps.stripe.forTraining(training) };
  if (!row || row.state !== "waiting") return row;
  if (account && row.stripe_setup_intent_id) {
    const si = await retrieveRoomSetupIntent(deps.stripe, account, row.stripe_setup_intent_id);
    if (si.status === "succeeded") return save(deps, venueId, id, si);
    try {
      await cancelReaderAction(deps.stripe, account, { tapId: id, readerId: row.stripe_reader_id });
    } catch (e) {
      if (!(e instanceof StripeError)) throw e;
    }
    try {
      await cancelRoomSetupIntent(deps.stripe, account, {
        tapId: id,
        setupIntent: row.stripe_setup_intent_id,
      });
    } catch (e) {
      if (!(e instanceof StripeError)) throw e;
    }
  }
  return inVenue(deps, venueId, async (c) => {
    await c.query(
      `update check_cards set state = 'canceled', settled_at = $3
        where venue_id = $1 and id = $2 and state = 'waiting'`,
      [venueId, id, deps.clock.now().toString()],
    );
    return cardRow(c, venueId, id);
  });
}
