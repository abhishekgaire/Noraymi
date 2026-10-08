import type { Temporal } from "@west4/shared";
import { hashOptOuts, type DueCard, type RetentionCounts } from "./retention.js";
import type { Queryable } from "./tenancy.js";

/**
 * Erasing a guest or a singer on request (M8-13; Security and data
 * retention · Erasing a guest). Every function here runs after
 * `asRetention()`, so the audit rows it causes name the fields it blanked,
 * never their old values. Checks, payments and the audit log stay. The
 * opt-out is hashed (M8-12's `opt_out_hash()`) before the number goes, so an
 * erased guest is never texted again. The outside calls (cards at Stripe,
 * bodies at Twilio) are listed in the erasure's `pending` and made by the
 * `guests.erase` job between transactions.
 */
export type ErasureSubject = "guest" | "singer";

export interface PendingMessage {
  readonly id: string;
  readonly provider_sid: string;
}

export interface ErasurePending {
  readonly cards: DueCard[];
  readonly messages: PendingMessage[];
}

export interface Erasure {
  readonly id: string;
  readonly subject: ErasureSubject;
  readonly subject_id: string;
  readonly requested_at: string;
  readonly state: "pending" | "done";
  readonly pending: Partial<ErasurePending>;
  readonly removed: Record<string, number | string>;
  readonly held_messages: number;
  readonly done_at: string | null;
}

const n = (r: { rowCount: number | null }) => r.rowCount ?? 0;
const ERASURE_COLUMNS = `id, subject, subject_id, requested_at, state, pending, removed, held_messages, done_at`;

export async function erasureOf(
  c: Queryable,
  venueId: string,
  subject: ErasureSubject,
  subjectId: string,
): Promise<Erasure | null> {
  const r = await c.query<Erasure>(
    `select ${ERASURE_COLUMNS} from erasures where venue_id = $1 and subject = $2 and subject_id = $3`,
    [venueId, subject, subjectId],
  );
  return r.rows[0] ?? null;
}

export async function erasureById(
  c: Queryable,
  venueId: string,
  id: string,
): Promise<Erasure | null> {
  const r = await c.query<Erasure>(
    `select ${ERASURE_COLUMNS} from erasures where venue_id = $1 and id = $2`,
    [venueId, id],
  );
  return r.rows[0] ?? null;
}

/** The erasure log's row (as app_rw, before the erase switches role). */
export async function startErasure(
  c: Queryable,
  venueId: string,
  input: {
    subject: ErasureSubject;
    subjectId: string;
    requestedBy: string | null;
    now: Temporal.Instant;
  },
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `insert into erasures (venue_id, subject, subject_id, requested_by, requested_at)
     values ($1, $2, $3, $4, $5) returning id`,
    [venueId, input.subject, input.subjectId, input.requestedBy, input.now.toString()],
  );
  return r.rows[0]!.id;
}

/**
 * A message is under a legal hold while its conversation's booking or room
 * session has a check with an open dispute (the ticket's cautious default;
 * nothing else marks a hold yet).
 */
const HELD = `exists (
  select 1 from checks k
   where k.venue_id = cv.venue_id
     and ((cv.context_kind = 'booking' and k.booking_id = cv.context_id)
       or (cv.context_kind = 'session' and exists (
             select 1 from room_sessions s where s.venue_id = cv.venue_id and s.id = cv.context_id
                and (s.check_id = k.id or (s.booking_id is not null and s.booking_id = k.booking_id)))))
     and exists (
       select 1 from disputes d
        where d.venue_id = k.venue_id and d.closed_at is null
          and (d.check_id = k.id or exists (
                select 1 from payment_allocations a
                 where a.venue_id = d.venue_id and a.payment_id = d.payment_id and a.check_id = k.id))))`;

/**
 * The person's texts and consents: bodies blanked here (Twilio's copy is
 * listed for the job), numbers gone from conversations and consents. A
 * conversation under a legal hold is kept whole and counted.
 */
async function eraseTexts(
  c: Queryable,
  venueId: string,
  who: { guestId: string | null; phone: string | null },
): Promise<{ removed: RetentionCounts; held: number; messages: PendingMessage[] }> {
  const params = [venueId, who.guestId, who.phone];
  const mine = `cv.venue_id = $1 and (cv.guest_id = $2::uuid or ($3::text is not null and cv.phone_e164 = $3::text))`;
  const held = await c.query<{ n: string }>(
    `select count(*) as n from messages m join conversations cv on cv.venue_id = m.venue_id and cv.id = m.conversation_id
      where ${mine} and ${HELD}`,
    params,
  );
  const open = `select cv.id from conversations cv where ${mine} and not ${HELD}`;
  const messages = await c.query<PendingMessage>(
    `select id, provider_sid from messages
      where venue_id = $1 and conversation_id in (${open})
        and provider_sid is not null and provider_body_purged_at is null
      order by created_at`,
    params,
  );
  const bodies = await c.query(
    `update messages set body = '' where venue_id = $1 and conversation_id in (${open}) and body <> ''`,
    params,
  );
  const conversations = await c.query(
    `update conversations set phone_e164 = '' where venue_id = $1 and id in (${open}) and phone_e164 <> ''`,
    params,
  );
  // A consent tied to the guest keeps its dates without the number; one known only by the number goes.
  const linked = await c.query(
    `update consents set phone_e164 = null
      where venue_id = $1 and guest_id = $2::uuid and phone_e164 is not null`,
    [venueId, who.guestId],
  );
  const unlinked = await c.query(
    `delete from consents where venue_id = $1 and guest_id is null and phone_e164 = $2::text`,
    [venueId, who.phone],
  );
  return {
    removed: {
      message_bodies: n(bodies),
      conversations: n(conversations),
      consents: n(linked) + n(unlinked),
    },
    held: Number(held.rows[0]?.n ?? 0),
    messages: messages.rows,
  };
}

const NOT_DETACHED = (alias: string, source: string) =>
  `not exists (select 1 from card_detaches d where d.venue_id = ${alias}.venue_id
                 and d.source = '${source}' and d.source_id = ${alias}.id)`;

/** The guest's saved cards: each booking's (saved or behind its deposit) and those saved on its checks. */
async function guestCards(c: Queryable, venueId: string, guestId: string): Promise<DueCard[]> {
  const r = await c.query<DueCard>(
    `select 'booking' as source, b.id as source_id, b.payment_method_id as payment_method,
            p.stripe_pi_id as deposit_pi, coalesce(p.training, false) as training
       from bookings b
       left join lateral (
         select p.stripe_pi_id, p.training from payments p
          where p.venue_id = b.venue_id and p.booking_id = b.id and p.method = 'card_online'
            and p.stripe_pi_id is not null and p.card_last4 is not null
          order by p.created_at limit 1) p on true
      where b.venue_id = $1 and b.guest_id = $2
        and (b.payment_method_id is not null or p.stripe_pi_id is not null)
        and ${NOT_DETACHED("b", "booking")}
     union all
     select 'check_card', cc.id, cc.stripe_payment_method_id, null, k.training
       from check_cards cc join checks k on k.venue_id = cc.venue_id and k.id = cc.check_id
       join bookings b on b.venue_id = k.venue_id and b.id = k.booking_id
      where cc.venue_id = $1 and b.guest_id = $2 and cc.state = 'saved'
        and cc.stripe_payment_method_id is not null and ${NOT_DETACHED("cc", "check_card")}`,
    [venueId, guestId],
  );
  return r.rows;
}

/** The singer's saved cards: the tab's on their check, and any saved on that check. */
async function singerCards(
  c: Queryable,
  venueId: string,
  checkId: string | null,
): Promise<DueCard[]> {
  if (!checkId) return [];
  const r = await c.query<DueCard>(
    `select 'tab' as source, t.id as source_id, p.generated_card_pm as payment_method,
            null::text as deposit_pi, p.training
       from tabs t join payments p on p.venue_id = t.venue_id and p.id = t.payment_id
      where t.venue_id = $1 and t.check_id = $2 and p.generated_card_pm is not null
        and ${NOT_DETACHED("t", "tab")}
     union all
     select 'check_card', cc.id, cc.stripe_payment_method_id, null, k.training
       from check_cards cc join checks k on k.venue_id = cc.venue_id and k.id = cc.check_id
      where cc.venue_id = $1 and cc.check_id = $2 and cc.state = 'saved'
        and cc.stripe_payment_method_id is not null and ${NOT_DETACHED("cc", "check_card")}`,
    [venueId, checkId],
  );
  return r.rows;
}

export interface ErasedNow {
  readonly removed: RetentionCounts;
  readonly held: number;
  readonly pending: ErasurePending;
}

async function finish(
  c: Queryable,
  venueId: string,
  erasureId: string,
  done: ErasedNow,
): Promise<void> {
  await c.query(
    `update erasures set pending = $3, removed = $4, held_messages = $5 where venue_id = $1 and id = $2`,
    [venueId, erasureId, JSON.stringify(done.pending), JSON.stringify(done.removed), done.held],
  );
}

/** Blank a guest (as app_retention): opt-out hashed first, then texts, consents and the guest row. */
export async function eraseGuest(
  c: Queryable,
  venueId: string,
  guestId: string,
  erasureId: string,
  now: Temporal.Instant,
): Promise<ErasedNow> {
  const done = await blankGuest(c, venueId, guestId, now.toString());
  await finish(c, venueId, erasureId, done);
  return done;
}

async function blankGuest(
  c: Queryable,
  venueId: string,
  guestId: string,
  at: string,
): Promise<ErasedNow> {
  const guest = await c.query<{ phone_e164: string | null }>(
    "select phone_e164 from guests where venue_id = $1 and id = $2",
    [venueId, guestId],
  );
  const phone = guest.rows[0]?.phone_e164 ?? null;
  const hashed = await hashOptOuts(c, venueId);
  const texts = await eraseTexts(c, venueId, { guestId, phone });
  const cards = await guestCards(c, venueId, guestId);
  const blanked = await c.query(
    `update guests set name = '', phone_e164 = null, email = null, erased_at = coalesce(erased_at, $3)
      where venue_id = $1 and id = $2`,
    [venueId, guestId, at],
  );
  return {
    removed: { opt_out_hashes: hashed, guests: n(blanked), ...texts.removed },
    held: texts.held,
    pending: { cards, messages: texts.messages },
  };
}

/** Does the singer's tab still owe money (its check isn't paid or void)? */
export async function singerOwes(
  c: Queryable,
  venueId: string,
  singerId: string,
): Promise<boolean | null> {
  const r = await c.query<{ owes: boolean }>(
    `select (s.check_id is not null and not exists (
               select 1 from checks k where k.venue_id = s.venue_id and k.id = s.check_id
                  and k.status in ('paid', 'void'))) as owes
       from singers s where s.venue_id = $1 and s.id = $2`,
    [venueId, singerId],
  );
  return r.rows[0]?.owes ?? null;
}

/**
 * Blank a singer whose tab owes nothing (as app_retention), the way the
 * nightly job pseudonymizes one (D91): the row stays so their songs and
 * money rows stay whole.
 */
export async function eraseSinger(
  c: Queryable,
  venueId: string,
  singerId: string,
  erasureId: string,
  now: Temporal.Instant,
): Promise<ErasedNow> {
  const done = await blankSinger(c, venueId, singerId, now.toString());
  await finish(c, venueId, erasureId, done);
  return done;
}

async function blankSinger(
  c: Queryable,
  venueId: string,
  singerId: string,
  at: string,
): Promise<ErasedNow> {
  const singer = await c.query<{ phone_e164: string | null; check_id: string | null }>(
    "select phone_e164, check_id from singers where venue_id = $1 and id = $2",
    [venueId, singerId],
  );
  const row = singer.rows[0];
  const hashed = await hashOptOuts(c, venueId);
  const texts = await eraseTexts(c, venueId, { guestId: null, phone: row?.phone_e164 ?? null });
  const cards = await singerCards(c, venueId, row?.check_id ?? null);
  await c.query("delete from singer_push_subscriptions where venue_id = $1 and singer_id = $2", [
    venueId,
    singerId,
  ]);
  const blanked = await c.query(
    `update singers set display_name = '—', phone_e164 = null, phone_verified_at = null, code_hash = null,
            code_expires_at = null, token_hash = null, erased_at = coalesce(erased_at, $3)
      where venue_id = $1 and id = $2`,
    [venueId, singerId, at],
  );
  return {
    removed: { opt_out_hashes: hashed, singers: n(blanked), ...texts.removed },
    held: texts.held,
    pending: { cards, messages: texts.messages },
  };
}

export interface Reapplied {
  readonly erasures: number;
  /** Erasures that found cards or Twilio bodies again: the guests.erase job works them off. */
  readonly reopened: string[];
}

/**
 * After a restore (M8-20): every erasure in the log, applied again, so a
 * guest or singer erased after the restore point stays erased. Runs as
 * app_retention like the first time. An erasure that finds saved cards or
 * message bodies again goes back to pending with that list, for the job.
 */
export async function reapplyErasures(c: Queryable, venueId: string): Promise<Reapplied> {
  const log = await c.query<Erasure>(
    `select ${ERASURE_COLUMNS} from erasures where venue_id = $1 order by requested_at, id`,
    [venueId],
  );
  const reopened: string[] = [];
  for (const e of log.rows) {
    const at = new Date(e.done_at ?? e.requested_at).toISOString();
    const again =
      e.subject === "guest"
        ? await blankGuest(c, venueId, e.subject_id, at)
        : await blankSinger(c, venueId, e.subject_id, at);
    if (again.pending.cards.length || again.pending.messages.length) {
      await c.query(
        `update erasures set state = 'pending', pending = $3, done_at = null
          where venue_id = $1 and id = $2`,
        [venueId, e.id, JSON.stringify(again.pending)],
      );
      reopened.push(e.id);
    }
  }
  return { erasures: log.rows.length, reopened };
}

/** The job's last step: nothing left outside, the counts kept. */
export async function closeErasure(
  c: Queryable,
  venueId: string,
  erasureId: string,
  removed: Record<string, number | string>,
  now: Temporal.Instant | null,
): Promise<void> {
  await c.query(
    `update erasures set removed = removed || $3::jsonb,
            state = case when $4::timestamptz is null then state else 'done' end,
            done_at = coalesce($4::timestamptz, done_at),
            pending = case when $4::timestamptz is null then pending else '{}'::jsonb end
      where venue_id = $1 and id = $2`,
    [venueId, erasureId, JSON.stringify(removed), now?.toString() ?? null],
  );
}
