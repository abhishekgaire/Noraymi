import type { Temporal } from "@west4/shared";
import type { Queryable } from "./tenancy.js";

/**
 * How long each kind of row is kept (Security and data retention · How long
 * we keep things), for M8's retention job: nothing on this list is removed
 * before its time, and the app itself never deletes these rows (the grants
 * test, M7-20). `years` is the minimum.
 */
export interface Retention {
  readonly table: string;
  readonly years: number;
  readonly why: string;
}

const WAGES = "New York's hospitality wage records (GA-M2)";
const CHECKS = "New York's record-keeping for guest checks (GA-M4)";

export const RETENTION: readonly Retention[] = [
  // GA-M2: the tip ledger, pools, shares, punches and shifts, 6 years.
  { table: "tip_ledger", years: 6, why: WAGES },
  { table: "tip_pools", years: 6, why: WAGES },
  { table: "tip_pool_occupations", years: 6, why: WAGES },
  { table: "tip_shares", years: 6, why: WAGES },
  { table: "time_punches", years: 6, why: WAGES },
  { table: "shifts", years: 6, why: WAGES },
  { table: "audit_log", years: 6, why: "Explains the records above" },
  // GA-M4: the money core and the nights, at least 3 years.
  { table: "checks", years: 3, why: CHECKS },
  { table: "check_lines", years: 3, why: CHECKS },
  { table: "check_revisions", years: 3, why: CHECKS },
  { table: "payments", years: 3, why: CHECKS },
  { table: "payment_allocations", years: 3, why: CHECKS },
  { table: "payment_events", years: 3, why: CHECKS },
  { table: "refunds", years: 3, why: CHECKS },
  { table: "night_closes", years: 3, why: CHECKS },
  { table: "drawer_sessions", years: 3, why: CHECKS },
  { table: "drawer_moves", years: 3, why: CHECKS },
  { table: "payouts", years: 3, why: CHECKS },
  { table: "payout_lines", years: 3, why: CHECKS },
  { table: "exports", years: 3, why: CHECKS },
];

/**
 * The nightly retention job's policy table (M8-12; Security and data
 * retention · How long we keep things). One row per kind: how long it is
 * kept, and what happens after. `keep` rows are never removed by the job;
 * `provider` rows are kept by the provider's own settings.
 */
export type RetentionAction =
  "pseudonymize" | "delete" | "purge_payload" | "detach" | "redact_at_twilio" | "keep" | "provider";

export interface RetentionRule {
  readonly kind: string;
  readonly action: RetentionAction;
  /** A Temporal duration-like: how long after its time the row is let go (or kept, for `keep`). */
  readonly after: { years?: number; months?: number; days?: number; hours?: number };
  readonly what: string;
}

export const RETENTION_POLICY: readonly RetentionRule[] = [
  {
    kind: "guests",
    action: "pseudonymize",
    after: { months: 24 },
    what: "24 months without a visit",
  },
  {
    kind: "bookings",
    action: "pseudonymize",
    after: { years: 3 },
    what: "3 years after the visit",
  },
  {
    kind: "waitlist_entries",
    action: "pseudonymize",
    after: { years: 3 },
    what: "3 years after joining",
  },
  { kind: "enquiries", action: "pseudonymize", after: { years: 3 }, what: "3 years after asking" },
  { kind: "messages", action: "delete", after: { years: 4 }, what: "4 years after the last text" },
  {
    kind: "consents",
    action: "delete",
    after: { years: 4 },
    what: "4 years after the last text; an opt-out stays as a keyed hash",
  },
  {
    kind: "message_bodies_at_twilio",
    action: "redact_at_twilio",
    after: { days: 30 },
    what: "30 days; our copy follows the messages row",
  },
  { kind: "print_payloads", action: "purge_payload", after: { days: 30 }, what: "30 days" },
  { kind: "webhook_payloads", action: "purge_payload", after: { days: 90 }, what: "90 days" },
  { kind: "idempotency_keys", action: "delete", after: { days: 7 }, what: "7 days" },
  { kind: "venue_events", action: "delete", after: { hours: 72 }, what: "72 hours" },
  {
    kind: "order_traces",
    action: "delete",
    after: { days: 30 },
    what: "30 days, with the logs and traces they point at (M8-16)",
  },
  {
    kind: "unattached_uploads",
    action: "delete",
    after: { hours: 24 },
    what: "24 hours (the files sweep, M2-13)",
  },
  {
    kind: "singers",
    action: "delete",
    after: { days: 30 },
    what: "30 days after the last song, unless they still owe money",
  },
  {
    kind: "booking_cards",
    action: "detach",
    after: { days: 30 },
    what: "30 days after the booking closes",
  },
  {
    kind: "tab_cards",
    action: "detach",
    after: { days: 7 },
    what: "7 days after the tab (or check) closes",
  },
  {
    kind: "incidents",
    action: "delete",
    after: { years: 3 },
    what: "at keep_until (the rule pack's incidentsYears)",
  },
  {
    kind: "logs_and_error_reports",
    action: "provider",
    after: { days: 30 },
    what: "the log groups' 30-day retention (infra/staging/ecs.tf)",
  },
  ...RETENTION.map((r) => ({
    kind: r.table,
    action: "keep" as const,
    after: { years: r.years },
    what: `at least ${r.years} years: ${r.why}`,
  })),
];

/** Each kind's cutoff instant: rows older than it are let go. Calendar months and years in the venue's zone. */
export function retentionCutoffs(
  now: Temporal.Instant,
  timeZone: string,
): Record<string, Temporal.Instant> {
  const local = now.toZonedDateTimeISO(timeZone);
  const out: Record<string, Temporal.Instant> = {};
  for (const r of RETENTION_POLICY) {
    if (r.action === "keep" || r.action === "provider") continue;
    out[r.kind] = local.subtract(r.after).toInstant();
  }
  return out;
}

/** What one run removed, by kind (counts only). */
export type RetentionCounts = Record<string, number>;

const n = (r: { rowCount: number | null }) => r.rowCount ?? 0;

/**
 * Become the retention role for this transaction. Every statement after it
 * sees only this venue's rows (the retention_wall policies) and may change
 * only what 0115 grants.
 */
export async function asRetention(c: Queryable): Promise<void> {
  await c.query("set local role app_retention");
  await c.query("set local statement_timeout = '60s'");
}

/** Opt-outs from texts, kept as keyed hashes of the number before anything below can remove them. */
export async function hashOptOuts(c: Queryable, venueId: string): Promise<number> {
  return n(
    await c.query(
      `with phones as (
         select coalesce(k.phone_e164, g.phone_e164) as phone, min(k.revoked_at) as revoked_at
           from consents k left join guests g on g.venue_id = k.venue_id and g.id = k.guest_id
          where k.venue_id = $1 and k.channel = 'sms' and k.kind = 'texts' and k.revoked_at is not null
            and coalesce(k.phone_e164, g.phone_e164) is not null
          group by 1)
       insert into opt_out_hashes (venue_id, phone_hash, revoked_at)
       select $1, opt_out_hash(phone), revoked_at from phones
       on conflict (venue_id, phone_hash) do nothing`,
      [venueId],
    ),
  );
}

type Cut = Record<string, Temporal.Instant>;
const at = (i: Temporal.Instant) => i.toString();

/** Guests, bookings, waitlist entries and enquiries past their time lose their personal fields. */
export async function pseudonymize(
  c: Queryable,
  venueId: string,
  cut: Cut,
  now: Temporal.Instant,
): Promise<RetentionCounts> {
  // A guest with a booking made or due inside the 24 months has been in touch: kept.
  const guests = await c.query(
    `update guests g set name = '', phone_e164 = null, email = null, erased_at = $3
      where g.venue_id = $1 and g.erased_at is null and coalesce(g.last_seen_at, g.created_at) < $2
        and not exists (select 1 from bookings b where b.venue_id = g.venue_id and b.guest_id = g.id
                          and (b.created_at >= $2 or b.starts_at >= $2))
        and not exists (select 1 from waitlist_entries w where w.venue_id = g.venue_id and w.guest_id = g.id
                          and w.joined_at >= $2)`,
    [venueId, at(cut["guests"]!), at(now)],
  );
  const bookings = await c.query(
    `update bookings set accepted_ip = null, accepted_ua = null, manage_token_hash = null,
            payment_method_id = null, pseudonymized_at = $3
      where venue_id = $1 and pseudonymized_at is null and ends_at < $2`,
    [venueId, at(cut["bookings"]!), at(now)],
  );
  // The confirmation texts' manage links (M5-10) go with the booking's own.
  await c.query(
    `delete from booking_links l using bookings b
      where l.venue_id = $1 and b.venue_id = l.venue_id and b.id = l.booking_id and b.ends_at < $2`,
    [venueId, at(cut["bookings"]!)],
  );
  const waitlist = await c.query(
    `update waitlist_entries set link_token_hash = null, link_expires_at = null, offer_message_id = null,
            pseudonymized_at = $3
      where venue_id = $1 and pseudonymized_at is null and joined_at < $2`,
    [venueId, at(cut["waitlist_entries"]!), at(now)],
  );
  const enquiries = await c.query(
    `update enquiries set message = null, pseudonymized_at = $3
      where venue_id = $1 and pseudonymized_at is null and created_at < $2`,
    [venueId, at(cut["enquiries"]!), at(now)],
  );
  return {
    guests: n(guests),
    bookings: n(bookings),
    waitlist_entries: n(waitlist),
    enquiries: n(enquiries),
  };
}

/** Messages, and consents, 4 years after the last text; a conversation left empty goes too. */
export async function removeTexts(
  c: Queryable,
  venueId: string,
  cut: Cut,
): Promise<RetentionCounts> {
  const before = at(cut["messages"]!);
  const stale = `select cv.id from conversations cv
                  where cv.venue_id = $1
                    and not exists (select 1 from messages m where m.venue_id = cv.venue_id
                                      and m.conversation_id = cv.id and m.created_at >= $2)`;
  await c.query(
    `update waitlist_entries set offer_message_id = null
      where venue_id = $1 and offer_message_id in
        (select m.id from messages m where m.venue_id = $1 and m.conversation_id in (${stale}))`,
    [venueId, before],
  );
  const messages = await c.query(
    // A body still at Twilio is redacted there first (the step before this one); until then the row waits.
    `delete from messages where venue_id = $1 and conversation_id in (${stale})
        and (provider_sid is null or provider_body_purged_at is not null)`,
    [venueId, before],
  );
  const empty = `cv.venue_id = $1 and cv.created_at < $2
                 and not exists (select 1 from messages m where m.venue_id = cv.venue_id and m.conversation_id = cv.id)`;
  const conversations = await c.query(
    `delete from conversations cv where ${empty}
        and not exists (select 1 from enquiries e where e.venue_id = cv.venue_id and e.conversation_id = cv.id)`,
    [venueId, before],
  );
  // An enquiry (kept 3 years, then pseudonymized) still points at its conversation: only the number goes.
  const blanked = await c.query(
    `update conversations cv set phone_e164 = '' where ${empty} and cv.phone_e164 <> ''`,
    [venueId, before],
  );
  const consents = await c.query(
    `delete from consents k
      where k.venue_id = $1
        and greatest(coalesce(k.given_at, '-infinity'), coalesce(k.revoked_at, '-infinity')) < $2
        and not exists (
          select 1 from conversations cv join messages m on m.venue_id = cv.venue_id and m.conversation_id = cv.id
           where cv.venue_id = k.venue_id and m.created_at >= $2
             and (cv.phone_e164 = k.phone_e164 or (k.guest_id is not null and cv.guest_id = k.guest_id)))`,
    [venueId, before],
  );
  return {
    messages: n(messages),
    conversations: n(conversations) + n(blanked),
    consents: n(consents),
  };
}

/** Payloads, keys, events, singers and incidents past their time. */
export async function removeExpired(
  c: Queryable,
  venueId: string,
  cut: Cut,
  now: Temporal.Instant,
): Promise<RetentionCounts> {
  const print = await c.query(
    `update print_jobs set payload = '{}'::jsonb, payload_purged_at = $3
      where venue_id = $1 and payload_purged_at is null and created_at < $2`,
    [venueId, at(cut["print_payloads"]!), at(now)],
  );
  const webhooks = await c.query(
    `update webhook_events set payload = '{}'::jsonb, payload_purged_at = $3
      where venue_id = $1 and payload_purged_at is null and received_at < $2`,
    [venueId, at(cut["webhook_payloads"]!), at(now)],
  );
  const keys = await c.query(
    "delete from idempotency_keys where venue_id = $1 and created_at < $2",
    [venueId, at(cut["idempotency_keys"]!)],
  );
  const events = await c.query(
    "delete from venue_events where venue_id = $1 and at < $2 and seq is not null",
    [venueId, at(cut["venue_events"]!)],
  );
  const uploads = await c.query<{ n: string }>(
    `select count(*) as n from files where venue_id = $1 and attached_at is null
        and removed_at is not null and removed_at > $2 and removed_at <= $3`,
    [venueId, at(now.subtract({ hours: 24 })), at(now)],
  );
  const traces = await c.query("delete from order_traces where venue_id = $1 and placed_at < $2", [
    venueId,
    at(cut["order_traces"]!),
  ]);
  const singers = await removeSingers(c, venueId, cut, now);
  await c.query(
    `delete from incident_notes where venue_id = $1 and incident_id in
       (select id from incidents where venue_id = $1 and keep_until is not null and keep_until < $2)`,
    [venueId, at(now)],
  );
  const incidents = await c.query(
    "delete from incidents where venue_id = $1 and keep_until is not null and keep_until < $2",
    [venueId, at(now)],
  );
  return {
    print_payloads: n(print),
    webhook_payloads: n(webhooks),
    idempotency_keys: n(keys),
    venue_events: n(events),
    order_traces: n(traces),
    unattached_uploads: Number(uploads.rows[0]?.n ?? 0),
    ...singers,
    incidents: n(incidents),
  };
}

/**
 * Singers 30 days after their last song, unless their tab still owes money
 * (its check isn't paid or void). One with no song, credit, play, gift or
 * prepaid code behind them is deleted; one whose songs explain a check is
 * pseudonymized instead, so the money records keep their rows (D91).
 */
async function removeSingers(
  c: Queryable,
  venueId: string,
  cut: Cut,
  now: Temporal.Instant,
): Promise<RetentionCounts> {
  const due = `select s.id from singers s
                where s.venue_id = $1 and s.erased_at is null and coalesce(s.last_song_at, s.joined_at) < $2
                  and (s.check_id is null or exists (
                        select 1 from checks k where k.venue_id = s.venue_id and k.id = s.check_id
                           and k.status in ('paid', 'void')))`;
  await c.query(
    `delete from singer_push_subscriptions where venue_id = $1 and singer_id in (${due})`,
    [venueId, at(cut["singers"]!)],
  );
  const deleted = await c.query(
    `delete from singers d where d.venue_id = $1 and d.id in (${due})
        and not exists (select 1 from song_queue q where q.venue_id = d.venue_id and q.singer_id = d.id)
        and not exists (select 1 from song_credits r where r.venue_id = d.venue_id and r.singer_id = d.id)
        and not exists (select 1 from song_plays p where p.venue_id = d.venue_id and p.singer_id = d.id)
        and not exists (select 1 from orders o where o.venue_id = d.venue_id and o.gift_for_singer_id = d.id)
        and not exists (select 1 from prepaid_accounts a where a.venue_id = d.venue_id and a.singer_id = d.id)`,
    [venueId, at(cut["singers"]!)],
  );
  const blanked = await c.query(
    `update singers set display_name = '—', phone_e164 = null, phone_verified_at = null, code_hash = null,
            code_expires_at = null, token_hash = null, erased_at = $3
      where venue_id = $1 and id in (${due})`,
    [venueId, at(cut["singers"]!), at(now)],
  );
  return { singers: n(deleted) + n(blanked) };
}

/** A saved card whose time is up: the booking's deposit, a tab's hold, or a card saved on a check. */
export interface DueCard {
  readonly source: "booking" | "tab" | "check_card";
  readonly source_id: string;
  /** The PaymentMethod, or for a booking the deposit's PaymentIntent to read it from. */
  readonly payment_method: string | null;
  readonly deposit_pi: string | null;
  readonly training: boolean;
}

export async function dueCards(c: Queryable, venueId: string, cut: Cut): Promise<DueCard[]> {
  const r = await c.query<DueCard>(
    `select 'tab' as source, t.id as source_id, p.generated_card_pm as payment_method,
            null::text as deposit_pi, p.training
       from tabs t join payments p on p.venue_id = t.venue_id and p.id = t.payment_id
      where t.venue_id = $1 and t.closed_at is not null and t.closed_at < $2
        and p.generated_card_pm is not null
        and not exists (select 1 from card_detaches d where d.venue_id = t.venue_id
                          and d.source = 'tab' and d.source_id = t.id)
     union all
     select 'check_card', cc.id, cc.stripe_payment_method_id, null, k.training
       from check_cards cc join checks k on k.venue_id = cc.venue_id and k.id = cc.check_id
      where cc.venue_id = $1 and cc.state = 'saved' and cc.stripe_payment_method_id is not null
        and k.status in ('paid', 'void') and coalesce(k.paid_at, k.opened_at) < $2
        and not exists (select 1 from card_detaches d where d.venue_id = cc.venue_id
                          and d.source = 'check_card' and d.source_id = cc.id)
     union all
     select distinct on (b.id) 'booking', b.id, null, p.stripe_pi_id, p.training
       from bookings b join payments p on p.venue_id = b.venue_id and p.booking_id = b.id
      where b.venue_id = $1 and b.status in ('completed', 'no_show', 'cancelled')
        and p.method = 'card_online' and p.stripe_pi_id is not null and p.card_last4 is not null
        and greatest(b.ends_at, coalesce((select max(k.paid_at) from checks k
                                           where k.venue_id = b.venue_id and k.booking_id = b.id), b.ends_at)) < $3
        and not exists (select 1 from checks k where k.venue_id = b.venue_id and k.booking_id = b.id
                          and k.status not in ('paid', 'void'))
        and not exists (select 1 from card_detaches d where d.venue_id = b.venue_id
                          and d.source = 'booking' and d.source_id = b.id)`,
    [venueId, at(cut["tab_cards"]!), at(cut["booking_cards"]!)],
  );
  return r.rows;
}

export async function recordCardDetach(
  c: Queryable,
  venueId: string,
  card: DueCard,
  paymentMethod: string | null,
  outcome: "detached" | "gone",
  now: Temporal.Instant,
): Promise<void> {
  await c.query(
    `insert into card_detaches (venue_id, source, source_id, stripe_payment_method_id, training, outcome, detached_at)
     values ($1, $2, $3, $4, $5, $6, $7) on conflict (venue_id, source, source_id) do nothing`,
    [venueId, card.source, card.source_id, paymentMethod, card.training, outcome, at(now)],
  );
}

/** Messages whose body is still at Twilio past 30 days. */
export async function dueTwilioBodies(
  c: Queryable,
  venueId: string,
  cut: Cut,
  limit = 500,
): Promise<{ id: string; provider_sid: string }[]> {
  const r = await c.query<{ id: string; provider_sid: string }>(
    `select id, provider_sid from messages
      where venue_id = $1 and provider_sid is not null and provider_body_purged_at is null and created_at < $2
      order by created_at limit $3`,
    [venueId, at(cut["message_bodies_at_twilio"]!), limit],
  );
  return r.rows;
}

export async function markTwilioBodyPurged(
  c: Queryable,
  venueId: string,
  id: string,
  now: Temporal.Instant,
): Promise<void> {
  await c.query(
    "update messages set provider_body_purged_at = $3 where venue_id = $1 and id = $2",
    [venueId, id, at(now)],
  );
}

export async function recordRetentionRun(
  c: Queryable,
  venueId: string,
  removed: RetentionCounts,
  skipped: Record<string, string>,
  now: Temporal.Instant,
): Promise<string> {
  const r = await c.query<{ id: string }>(
    "insert into retention_runs (venue_id, ran_at, removed, skipped) values ($1, $2, $3, $4) returning id",
    [venueId, at(now), JSON.stringify(removed), JSON.stringify(skipped)],
  );
  return r.rows[0]!.id;
}
