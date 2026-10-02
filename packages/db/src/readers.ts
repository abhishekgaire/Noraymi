import type { Queryable } from "./tenancy.js";

/**
 * Card readers (M4-02; Stripe setup 4; spec 09 · Heartbeats). Each reader is
 * a `devices` row of kind reader holding its Stripe reader id. Its health is
 * read from Stripe every 30 seconds and kept in `device_heartbeats`, never in
 * the audit log; two minutes without an online reading raises device.offline
 * through the quiet-device sweep, the same rule Stripe uses.
 */
export interface VenueTerminal {
  readonly name: string;
  readonly address: { line1?: string; city?: string; state?: string; postal_code?: string } | null;
  readonly location_id: string | null;
  readonly config_id: string | null;
}

export async function venueTerminal(c: Queryable, venueId: string): Promise<VenueTerminal> {
  const r = await c.query<VenueTerminal>(
    `select name, address, stripe_location_id as location_id, stripe_terminal_config_id as config_id
       from venues where id = $1`,
    [venueId],
  );
  return r.rows[0]!;
}

export async function setVenueTerminal(
  c: Queryable,
  venueId: string,
  ids: { locationId: string; configId: string },
): Promise<void> {
  await c.query(
    "update venues set stripe_location_id = $2, stripe_terminal_config_id = $3 where id = $1",
    [venueId, ids.locationId, ids.configId],
  );
}

export interface ReaderRow {
  readonly id: string;
  readonly name: string;
  readonly stripe_reader_id: string | null;
  readonly reader_model: string | null;
  readonly cellular: boolean | null;
  readonly online: boolean;
  readonly last_seen_at: string | null;
}

export async function venueReaders(c: Queryable, venueId: string): Promise<ReaderRow[]> {
  const r = await c.query<ReaderRow>(
    `select d.id, d.name, d.stripe_reader_id, d.reader_model, d.cellular,
            (h.last_seen_at is not null and h.offline_since is null) as online,
            to_json(h.last_seen_at) #>> '{}' as last_seen_at
       from devices d left join device_heartbeats h on h.venue_id = d.venue_id and h.device_id = d.id
      where d.venue_id = $1 and d.kind = 'reader' and d.revoked_at is null
      order by d.name`,
    [venueId],
  );
  return r.rows;
}

/** A reader of this venue, by our device id: its Stripe id, or null (not ours, revoked or not registered). */
export async function readerOfVenue(
  c: Queryable,
  venueId: string,
  deviceId: string,
): Promise<{ id: string; name: string; stripe_reader_id: string } | null> {
  const r = await c.query<{ id: string; name: string; stripe_reader_id: string }>(
    `select id, name, stripe_reader_id from devices
      where venue_id = $1 and id = $2 and kind = 'reader' and revoked_at is null and disabled_at is null
        and stripe_reader_id is not null`,
    [venueId, deviceId],
  );
  return r.rows[0] ?? null;
}

/** A newly registered reader: the venue's reader row of the same name is taken over (the seed's, or one being replaced). */
export async function saveReader(
  c: Queryable,
  venueId: string,
  input: { name: string; stripeReaderId: string; model: string; cellular: boolean },
): Promise<string> {
  const existing = await c.query<{ id: string }>(
    `update devices set stripe_reader_id = $3, reader_model = $4, cellular = $5
      where id = (select id from devices where venue_id = $1 and kind = 'reader' and name = $2
                    and revoked_at is null order by stripe_reader_id nulls first limit 1)
      returning id`,
    [venueId, input.name, input.stripeReaderId, input.model, input.cellular],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const r = await c.query<{ id: string }>(
    `insert into devices (venue_id, kind, name, stripe_reader_id, reader_model, cellular)
       values ($1, 'reader', $2, $3, $4, $5) returning id`,
    [venueId, input.name, input.stripeReaderId, input.model, input.cellular],
  );
  return r.rows[0]!.id;
}

/** Readers Stripe says are online: a heartbeat each. Returns the ones that were flagged offline and are back. */
export async function recordReadersSeen(
  c: Queryable,
  venueId: string,
  deviceIds: readonly string[],
  now: Date,
): Promise<string[]> {
  if (deviceIds.length === 0) return [];
  const before = await c.query<{ device_id: string }>(
    `select device_id from device_heartbeats
      where venue_id = $1 and device_id = any($2::uuid[]) and offline_since is not null`,
    [venueId, deviceIds],
  );
  await c.query(
    `insert into device_heartbeats (device_id, venue_id, last_seen_at)
     select d.id, d.venue_id, $3 from devices d
      where d.venue_id = $1 and d.id = any($2::uuid[]) and d.kind = 'reader' and d.revoked_at is null
     on conflict (device_id) do update set last_seen_at = excluded.last_seen_at, offline_since = null`,
    [venueId, deviceIds, now],
  );
  return before.rows.map((r) => r.device_id);
}
