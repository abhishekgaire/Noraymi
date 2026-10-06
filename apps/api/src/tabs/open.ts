import { createHash } from "node:crypto";
import type pg from "pg";
import {
  clearDraft,
  draftFor,
  emitEvent,
  enqueue,
  insertCheck,
  insertPayment,
  latestAttempt,
  nextCheckNumber,
  paymentById,
  readSetting,
  readerOfVenue,
  saveDraft,
  startAttempt,
  stripeAccountOf,
  withVenue,
  type PaymentRow,
  type Queryable,
} from "@west4/db";
import { businessDate } from "@west4/rules";
import { TAB_CARD_HELD, tabConsentLine, tabNameFromCard, type Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { venueClock } from "../rooms/assignment.js";
import { confirmOnReader } from "../stripe/surcharge.js";
import { retrieveCollectedCard } from "../stripe/tabs.js";
import type { IntentObservation } from "../stripe/payments.js";
import { cancelPayment, type PaymentDeps } from "../payments/run.js";

/**
 * Opening a bar tab, card first (M6-06; Payment flows · Bar tab with a growing
 * hold, the consent line and steps 1 and 2; Staff screens and the bar POS ·
 * Tabs, card first):
 *  1. New tab shows the consent line, built from the `tabs` settings and saved
 *     as a `policy_versions` row (kind tab_consent) whenever its words change.
 *  2. Open (`POST /tabs`) records who read it and the version, takes the new
 *     check's number, and writes the opening hold's payment with a `collect`
 *     attempt; the payment run (M4-05) makes the Customer and the
 *     manual-capture PaymentIntent and puts the bar reader to work collecting.
 *  3. Once the card is collected, its fingerprint is checked against the
 *     venue's open tabs before `confirm_payment_intent`: a match cancels the
 *     PaymentIntent unconfirmed (no second hold) and opens that tab instead.
 *  4. When the hold is placed, the tab is made with its card, hold and consent,
 *     and the opener's Quick sale drinks move onto it, unsent. A card that
 *     brought no fingerprint before confirm is checked again here, and a match
 *     releases the new hold at once (the ticket's cautious default).
 */
export const TAB_RELEASE_KIND = "tab.release_hold";

/** "visa" → "Visa", as the bar's tab list shows it. */
const BRANDS: Record<string, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "Amex",
  american_express: "Amex",
  discover: "Discover",
  jcb: "JCB",
  diners: "Diners Club",
  unionpay: "UnionPay",
};
export const brandName = (brand: string | null): string | null =>
  brand ? (BRANDS[brand.toLowerCase()] ?? brand.charAt(0).toUpperCase() + brand.slice(1)) : null;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * The consent line read out tonight, and its `policy_versions` row: the latest version when its
 * words are tonight's, or a new version when the tab settings changed them.
 */
export async function tabConsent(c: Queryable, venueId: string, now: Temporal.Instant) {
  const venue = await venueClock(c, venueId);
  const date = businessDate(now, venue.timeZone, venue.dayCutover).businessDate;
  const tabs = await readSetting(c, venueId, "tabs", date);
  if (!tabs)
    throw new ApiError("invalid_request", "set the opening hold and the tab cut-off first", {
      details: { reason: "no_tab_settings" },
    });
  const text = tabConsentLine(tabs.value);
  const hash = sha256(text);
  // One writer at a time per venue, so two screens never publish the same version twice.
  await c.query("select pg_advisory_xact_lock(hashtext('tab_consent:' || $1::text))", [venueId]);
  const latest = (
    await c.query<{ id: string; version: number; hash: string }>(
      `select id, version, hash from policy_versions where venue_id = $1 and kind = 'tab_consent'
        order by version desc limit 1`,
      [venueId],
    )
  ).rows[0];
  let id = latest?.id;
  let version = latest?.version ?? 0;
  if (!latest || latest.hash !== hash) {
    version += 1;
    id = (
      await c.query<{ id: string }>(
        `insert into policy_versions (venue_id, kind, version, text, hash, published_at)
         values ($1, 'tab_consent', $2, $3, $4, $5) returning id`,
        [venueId, version, text, hash, now.toString()],
      )
    ).rows[0]!.id;
  }
  const pay = await readSetting(c, venueId, "pay", date);
  return {
    version_id: id!,
    version,
    text,
    hold_cents: tabs.value.openingHoldCents,
    cut_off_at: tabs.value.cutOffAt,
    // Parties mode: the gratuity goes on by party size, so New tab asks for it.
    asks_party_size: pay?.value.gratuity.auto === "parties",
    business_date: date.toString(),
  };
}

export async function reserveTabCheckNumber(pool: pg.Pool, venueId: string, training = false) {
  return nextCheckNumber(pool, venueId, { training });
}

export interface OpenTabInput {
  readonly readerDeviceId: string;
  readonly consentVersionId: string;
  readonly name: string | null;
  readonly label: string | null;
  readonly partySize: number | null;
  readonly checkNumber: number;
  readonly userId: string;
  readonly membershipId: string;
  /** Training mode (M7-03): the hold is practice, and so is the tab it opens. */
  readonly training?: boolean;
  readonly now: Temporal.Instant;
}

/** Step 2, inside the request's transaction: the opening, its hold's payment and the `collect` attempt. */
export async function writeTabOpening(
  c: Queryable,
  venueId: string,
  input: OpenTabInput,
  checks: {
    readerQuiet: (
      c: Queryable,
      venueId: string,
      deviceId: string,
      now: Temporal.Instant,
    ) => Promise<boolean>;
    enqueueRun: (
      c: Queryable,
      venueId: string,
      paymentId: string,
      attemptNo: number,
      now: Temporal.Instant,
    ) => Promise<void>;
  },
) {
  const consent = await tabConsent(c, venueId, input.now);
  // The words read out must be tonight's: a version from before a settings change is refused.
  if (consent.version_id !== input.consentVersionId)
    throw new ApiError("invalid_request", "the consent line changed: read the new one", {
      details: { reason: "consent_changed", consent },
    });
  if (consent.asks_party_size && !input.partySize)
    throw new ApiError("invalid_request", "how many in the party?", {
      details: { reason: "party_size" },
    });
  const reader = await readerOfVenue(c, venueId, input.readerDeviceId);
  if (!reader) throw new ApiError("not_found", "no such reader");
  if (await checks.readerQuiet(c, venueId, input.readerDeviceId, input.now))
    throw new ApiError("reader_offline", "the bar reader is offline: no new tabs until it's back", {
      details: { reader_id: input.readerDeviceId },
    });
  const paymentId = await insertPayment(c, venueId, {
    method: "card_present",
    status: "pending",
    businessDate: consent.business_date,
    training: input.training ?? false,
  });
  const { attemptNo } = await startAttempt(c, venueId, {
    paymentId,
    portionKey: "tab",
    action: "collect",
    readerId: reader.stripe_reader_id,
    amountCents: consent.hold_cents,
    startedAt: input.now.toString(),
  });
  const opening = (
    await c.query<{ id: string }>(
      `insert into tab_openings (venue_id, payment_id, check_number, name, label, party_size,
         consent_text_version, consent_read_by, opened_by, membership_id, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10) returning id`,
      [
        venueId,
        paymentId,
        input.checkNumber,
        input.name,
        input.label,
        input.partySize,
        consent.version_id,
        input.userId,
        input.membershipId,
        input.now.toString(),
      ],
    )
  ).rows[0]!.id;
  await checks.enqueueRun(c, venueId, paymentId, attemptNo, input.now);
  return { openingId: opening, paymentId, attemptNo };
}

interface OpeningRow {
  id: string;
  payment_id: string;
  check_number: number;
  name: string | null;
  label: string | null;
  party_size: number | null;
  consent_text_version: string;
  consent_read_by: string;
  opened_by: string;
  membership_id: string | null;
  card_brand: string | null;
  card_last4: string | null;
  card_fingerprint: string | null;
  card_name: string | null;
  state: "waiting" | "opened" | "existing" | "canceled";
  tab_id: string | null;
}

export async function openingOfPayment(
  c: Queryable,
  venueId: string,
  paymentId: string,
  lock = false,
): Promise<OpeningRow | null> {
  const r = await c.query<OpeningRow>(
    `select id, payment_id, check_number, name, label, party_size, consent_text_version, consent_read_by,
            opened_by, membership_id, card_brand, card_last4, card_fingerprint, card_name, state, tab_id
       from tab_openings where venue_id = $1 and payment_id = $2${lock ? " for update" : ""}`,
    [venueId, paymentId],
  );
  return r.rows[0] ?? null;
}

/** The card's open tab at the venue (one per card while it's open), under a lock on the fingerprint. */
async function openTabOfCard(c: Queryable, venueId: string, fingerprint: string) {
  await c.query("select pg_advisory_xact_lock(hashtext('tab_card:' || $1::text || $2::text))", [
    venueId,
    fingerprint,
  ]);
  const r = await c.query<{ id: string; check_id: string }>(
    `select id, check_id from tabs
      where venue_id = $1 and card_fingerprint = $2 and state = any($3) limit 1`,
    [venueId, fingerprint, TAB_CARD_HELD],
  );
  return r.rows[0] ?? null;
}

/** The opener's Quick sale drinks, moved onto the tab unsent (they're sent, and the hold grows, from the tab). */
async function moveQuickRound(
  c: Queryable,
  venueId: string,
  o: OpeningRow,
  checkId: string,
  now: Temporal.Instant,
) {
  if (!o.membership_id) return;
  const quick = await draftFor(c, venueId, o.membership_id, null);
  const lines = (quick?.lines ?? []) as unknown[];
  if (lines.length === 0) return;
  const onTab = await draftFor(c, venueId, o.membership_id, checkId);
  const version = await saveDraft(c, venueId, {
    membershipId: o.membership_id,
    checkId,
    deviceId: null,
    lines: [...((onTab?.lines ?? []) as unknown[]), ...lines],
    version: onTab?.version ?? 0,
    at: now.toString(),
  });
  const cleared = await clearDraft(c, venueId, o.membership_id, null, now.toString());
  for (const [key, v] of [
    [checkId, version],
    ["quick", cleared],
  ] as const)
    if (v !== null)
      await emitEvent(c, {
        venueId,
        type: "draft.updated",
        entityId: key,
        entityVersion: v,
        audience: "user",
        userId: o.opened_by,
      });
}

async function settleExisting(
  c: Queryable,
  venueId: string,
  o: OpeningRow,
  tab: { id: string; check_id: string },
  now: Temporal.Instant,
) {
  await c.query(
    `update tab_openings set state = 'existing', tab_id = $3, settled_at = $4
      where venue_id = $1 and id = $2`,
    [venueId, o.id, tab.id, now.toString()],
  );
  await moveQuickRound(c, venueId, o, tab.check_id, now);
  await emitEvent(c, { venueId, type: "tab.updated", entityId: tab.id });
}

/**
 * Step 3, outside any transaction (the webhook for the reader's collect, or the payment's poll):
 * the collected card is checked against the venue's open tabs, then the hold is confirmed, or the
 * PaymentIntent is canceled unconfirmed and the card's open tab opens instead.
 * Returns false when the payment isn't a tab's opening hold.
 */
export async function confirmTabCard(
  deps: PaymentDeps,
  venueId: string,
  paymentId: string,
): Promise<boolean> {
  const inVenue = <T>(work: (c: Queryable) => Promise<T>) =>
    withVenue(deps.pool, { venueId, requestId: `tab-open:${paymentId}` }, work);
  const ctx = await inVenue(async (c) => {
    const opening = await openingOfPayment(c, venueId, paymentId);
    if (!opening) return null;
    return {
      opening,
      payment: await paymentById(c, venueId, paymentId),
      attempt: await latestAttempt(c, venueId, paymentId),
      account: await stripeAccountOf(c, venueId),
    };
  });
  if (!ctx) return false;
  const { payment, attempt, account } = ctx;
  if (!payment?.stripe_pi_id || !account || !attempt?.reader_id) return true;
  if (ctx.opening.state === "canceled" || ctx.opening.state === "opened") return true;
  const card = await retrieveCollectedCard(deps.stripe, account, payment.stripe_pi_id);
  if (card.status !== "requires_confirmation") return true;
  const decided = await inVenue(async (c) => {
    const o = (await openingOfPayment(c, venueId, paymentId, true))!;
    if (o.state !== "waiting") return o.state;
    await c.query(
      `update tab_openings set card_brand = $3, card_last4 = $4, card_fingerprint = $5, card_name = $6
        where venue_id = $1 and id = $2`,
      [
        venueId,
        o.id,
        brandName(card.brand),
        card.last4,
        card.fingerprint,
        tabNameFromCard(card.cardholderName),
      ],
    );
    const tab = card.fingerprint ? await openTabOfCard(c, venueId, card.fingerprint) : null;
    if (!tab) return "confirm" as const;
    await settleExisting(c, venueId, o, tab, deps.clock.now());
    return "existing" as const;
  });
  if (decided === "existing") {
    // No second hold: the PaymentIntent is canceled before it's ever confirmed.
    await cancelPayment(deps, venueId, paymentId, "api");
  } else if (decided === "confirm") {
    await confirmOnReader(
      deps.stripe,
      account,
      { readerId: attempt.reader_id, piId: payment.stripe_pi_id },
      `${paymentId}:confirm:${attempt.attempt_no}`,
    );
  }
  return true;
}

/**
 * Step 4, inside the state machine's transaction when the opening hold is placed (or ends):
 * the hold's terms on the payment, then the new tab, or the card's open tab with the new hold
 * released at once. A hold that's canceled or failed leaves nothing opened.
 */
export async function settleTabOpening(
  c: Queryable,
  venueId: string,
  payment: PaymentRow,
  intent: IntentObservation | null | undefined,
  now: Temporal.Instant,
) {
  const o = await openingOfPayment(c, venueId, payment.id, true);
  if (!o) return;
  if (payment.status === "canceled" || payment.status === "failed") {
    if (o.state === "waiting")
      await c.query(
        "update tab_openings set state = 'canceled', settled_at = $3 where venue_id = $1 and id = $2",
        [venueId, o.id, now.toString()],
      );
    return;
  }
  if (payment.status !== "authorized" || o.state !== "waiting") return;
  const hold = intent?.hold ?? null;
  await c.query(
    `update payments set incremental_supported = coalesce($3, incremental_supported),
            overcapture_supported = coalesce($4, overcapture_supported),
            capture_before = coalesce($5::timestamptz, capture_before),
            generated_card_pm = coalesce($6, generated_card_pm)
      where venue_id = $1 and id = $2`,
    [
      venueId,
      payment.id,
      hold?.incrementalSupported ?? null,
      hold?.overcaptureSupported ?? null,
      hold?.captureBefore ?? null,
      intent?.card?.generatedCard ?? null,
    ],
  );
  const fingerprint = o.card_fingerprint ?? hold?.fingerprint ?? null;
  if (fingerprint) {
    const tab = await openTabOfCard(c, venueId, fingerprint);
    if (tab) {
      // The card's fingerprint came only with the hold: release the new hold at once.
      await settleExisting(c, venueId, o, tab, now);
      await enqueue(c, {
        venueId,
        kind: TAB_RELEASE_KIND,
        pool: "critical",
        dedupeKey: `${TAB_RELEASE_KIND}:${payment.id}`,
        payload: { payment_id: payment.id },
        runAt: now,
        maxAttempts: 5,
      });
      return;
    }
  }
  const venue = await venueClock(c, venueId);
  const date = businessDate(now, venue.timeZone, venue.dayCutover).businessDate.toString();
  const checkId = await insertCheck(c, {
    venueId,
    number: o.check_number,
    kind: "bar",
    businessDate: date,
    openedBy: o.opened_by,
    openedAt: now.toString(),
    training: payment.training,
  });
  const brand = o.card_brand ?? brandName(intent?.card?.brand ?? payment.card_brand);
  const last4 = o.card_last4 ?? intent?.card?.last4 ?? payment.card_last4;
  const cardName = o.card_name ?? tabNameFromCard(hold?.cardholderName);
  // A typed first name wins; then the name a dip or swipe brought; then the label; then the card.
  const name =
    o.name ?? cardName ?? o.label ?? (last4 ? `${brand ?? ""} ··${last4}`.trim() : "Tab");
  const held = hold?.amountAuthorized ?? intent?.amountCapturable ?? 0;
  const tabId = (
    await c.query<{ id: string }>(
      `insert into tabs (venue_id, check_id, payment_id, state, name, label, card_brand, card_last4,
         card_fingerprint, hold_cents, party_size, owner_id, opened_by, opened_at, consent_text_version,
         consent_read_by)
       values ($1, $2, $3, 'open', $4, $5, $6, $7, $8, $9, $10, $11, $11, $12, $13, $14) returning id`,
      [
        venueId,
        checkId,
        payment.id,
        name,
        o.label,
        brand,
        last4,
        fingerprint,
        held,
        o.party_size,
        o.opened_by,
        now.toString(),
        o.consent_text_version,
        o.consent_read_by,
      ],
    )
  ).rows[0]!.id;
  await c.query(
    `update tab_openings set state = 'opened', tab_id = $3, settled_at = $4
      where venue_id = $1 and id = $2`,
    [venueId, o.id, tabId, now.toString()],
  );
  await moveQuickRound(c, venueId, o, checkId, now);
  await emitEvent(c, { venueId, type: "check.updated", entityId: checkId });
  await emitEvent(c, { venueId, type: "tab.updated", entityId: tabId });
}

/** What New tab shows while the card is on the reader, and the tab it opened. */
export async function openingView(c: Queryable, venueId: string, openingId: string) {
  const o = (
    await c.query<OpeningRow & { tab_name: string | null; tab_check_id: string | null }>(
      `select o.id, o.payment_id, o.state, o.card_brand, o.card_last4, o.tab_id,
              t.name as tab_name, t.check_id as tab_check_id
         from tab_openings o left join tabs t on t.venue_id = o.venue_id and t.id = o.tab_id
        where o.venue_id = $1 and o.id = $2`,
      [venueId, openingId],
    )
  ).rows[0];
  if (!o) throw new ApiError("not_found", "no such tab opening");
  return o;
}

/**
 * Open (M6-06): the name the bartender typed or the label they tapped, given while the guest taps.
 * The opening keeps it; a tab it already opened takes it at once. A typed first name wins, then the
 * name a dip or swipe brought, then the label, then the card.
 */
export async function nameOpening(
  c: Queryable,
  venueId: string,
  openingId: string,
  input: { name: string | null; label: string | null },
) {
  const o = (
    await c.query<{ state: string; tab_id: string | null }>(
      `update tab_openings set name = $3, label = $4 where venue_id = $1 and id = $2
        returning state, tab_id`,
      [venueId, openingId, input.name, input.label],
    )
  ).rows[0];
  if (!o) throw new ApiError("not_found", "no such tab opening");
  if (o.state === "opened" && o.tab_id) {
    await c.query(
      `update tabs t set label = $3,
              name = coalesce($4, o.card_name, $3,
                              nullif(trim(coalesce(t.card_brand, '') || ' ··' || t.card_last4), '··'), t.name)
         from tab_openings o
        where t.venue_id = $1 and t.id = $2 and o.venue_id = t.venue_id and o.id = $5`,
      [venueId, o.tab_id, input.label, input.name, openingId],
    );
    await emitEvent(c, { venueId, type: "tab.updated", entityId: o.tab_id });
  }
}
