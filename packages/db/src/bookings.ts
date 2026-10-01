import type { Queryable } from "./tenancy.js";

/**
 * Guests and bookings (M2-06; spec 04). Inside a venue transaction.
 */
export type BookingStatus =
  "pending" | "confirmed" | "checked_in" | "no_show" | "cancelled" | "completed";

export interface GuestInput {
  readonly name: string;
  readonly phoneE164?: string | null;
  readonly email?: string | null;
  readonly locale?: "en" | "es";
}

/** A guest by phone at this venue, or a new one. Guests are never shared across venues. */
export async function findOrCreateGuest(
  c: Queryable,
  venueId: string,
  input: GuestInput,
  id?: string,
): Promise<string> {
  if (input.phoneE164 && !id) {
    const found = await c.query<{ id: string }>(
      "select id from guests where venue_id = $1 and phone_e164 = $2 and erased_at is null order by created_at limit 1",
      [venueId, input.phoneE164],
    );
    if (found.rows[0]) return found.rows[0].id;
  }
  const r = await c.query<{ id: string }>(
    `insert into guests (id, venue_id, name, phone_e164, email, locale)
       values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6) returning id`,
    [
      id ?? null,
      venueId,
      input.name,
      input.phoneE164 ?? null,
      input.email ?? null,
      input.locale ?? "en",
    ],
  );
  return r.rows[0]!.id;
}

export interface BookingRow {
  readonly id: string;
  readonly guest_id: string;
  readonly guest_name: string;
  readonly guest_phone: string | null;
  readonly room_id: string;
  readonly room_name: string;
  readonly size_tier: string;
  readonly party_size: number;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly business_date: string;
  readonly status: BookingStatus;
  readonly source: "web" | "staff" | "import";
  readonly deposit_cents: number;
  readonly refund_cutoff_at: string | null;
  readonly running_late_until: string | null;
  readonly pending_until: string | null;
}

const iso = (col: string) => `to_json(${col}) #>> '{}'`;
const COLS = `b.id, b.guest_id, g.name as guest_name, g.phone_e164 as guest_phone, b.room_id, r.name as room_name,
  b.size_tier, b.party_size, ${iso("b.starts_at")} as starts_at, ${iso("b.ends_at")} as ends_at,
  b.business_date::text, b.status, b.source, b.deposit_cents, ${iso("b.refund_cutoff_at")} as refund_cutoff_at,
  ${iso("b.running_late_until")} as running_late_until, ${iso("b.pending_until")} as pending_until`;
const FROM = `from bookings b join guests g on g.venue_id = b.venue_id and g.id = b.guest_id
  join rooms r on r.venue_id = b.venue_id and r.id = b.room_id`;

export async function bookingById(
  c: Queryable,
  venueId: string,
  id: string,
): Promise<BookingRow | null> {
  const r = await c.query<BookingRow>(
    `select ${COLS} ${FROM} where b.venue_id = $1 and b.id = $2`,
    [venueId, id],
  );
  return r.rows[0] ?? null;
}

export async function bookingsOn(
  c: Queryable,
  venueId: string,
  businessDate: string,
): Promise<BookingRow[]> {
  const r = await c.query<BookingRow>(
    `select ${COLS} ${FROM} where b.venue_id = $1 and b.business_date = $2 order by b.starts_at, r.name`,
    [venueId, businessDate],
  );
  return r.rows;
}

export interface BookingInput {
  readonly guestId: string;
  readonly roomId: string;
  readonly sizeTier: string;
  readonly partySize: number;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly businessDate: string;
  readonly status: BookingStatus;
  readonly source: "web" | "staff" | "import";
  readonly depositCents: number;
  readonly refundCutoffAt: string | null;
  readonly runningLateUntil?: string | null;
}

export async function insertBooking(
  c: Queryable,
  venueId: string,
  input: BookingInput,
  id?: string,
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `insert into bookings (id, venue_id, guest_id, room_id, size_tier, party_size, starts_at, ends_at, business_date,
       status, source, deposit_cents, refund_cutoff_at, running_late_until)
     values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     returning id`,
    [
      id ?? null,
      venueId,
      input.guestId,
      input.roomId,
      input.sizeTier,
      input.partySize,
      input.startsAt,
      input.endsAt,
      input.businessDate,
      input.status,
      input.source,
      input.depositCents,
      input.refundCutoffAt,
      input.runningLateUntil ?? null,
    ],
  );
  return r.rows[0]!.id;
}

export async function updateBooking(
  c: Queryable,
  venueId: string,
  id: string,
  patch: {
    roomId?: string;
    sizeTier?: string;
    partySize?: number;
    status?: BookingStatus;
    cancelledBy?: string | null;
  },
): Promise<boolean> {
  const r = await c.query(
    `update bookings set
        room_id = coalesce($3, room_id), size_tier = coalesce($4, size_tier),
        party_size = coalesce($5, party_size), status = coalesce($6, status),
        cancelled_by = case when $6 = 'cancelled' then $7::uuid else cancelled_by end
      where venue_id = $1 and id = $2`,
    [
      venueId,
      id,
      patch.roomId ?? null,
      patch.sizeTier ?? null,
      patch.partySize ?? null,
      patch.status ?? null,
      patch.cancelledBy ?? null,
    ],
  );
  return r.rowCount === 1;
}
