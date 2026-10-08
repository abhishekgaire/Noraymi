import type { Queryable } from "./tenancy.js";

/**
 * Guests joined to a room (M3-08). The resolvers find the venue from a hash
 * before any venue is set (definer functions); everything else runs inside
 * a venue transaction.
 */
export async function resolveRoomSession(
  c: Queryable,
  tokenHash: string,
): Promise<{ venueId: string; roomGuestId: string } | null> {
  const r = await c.query<{ venue_id: string; room_guest_id: string }>(
    "select venue_id, room_guest_id from resolve_room_session($1)",
    [tokenHash],
  );
  const row = r.rows[0];
  return row ? { venueId: row.venue_id, roomGuestId: row.room_guest_id } : null;
}

export async function resolveRoomHost(
  c: Queryable,
  hostTokenHash: string,
): Promise<{ venueId: string; sessionId: string } | null> {
  const r = await c.query<{ venue_id: string; session_id: string }>(
    "select venue_id, session_id from resolve_room_host($1)",
    [hostTokenHash],
  );
  const row = r.rows[0];
  return row ? { venueId: row.venue_id, sessionId: row.session_id } : null;
}

export interface RoomGuestRow {
  readonly id: string;
  readonly session_id: string;
  /** The room the token was issued in. */
  readonly room_id: string;
  readonly room_name: string;
  readonly is_host: boolean;
  readonly token_version: number;
  readonly name: string | null;
  readonly alcohol_cut_off_at: string | null;
  readonly session: {
    readonly room_id: string;
    readonly room_name: string;
    readonly token_version: number;
    readonly ended: boolean;
    readonly room_code_enc: string | null;
    readonly host_lock: boolean;
    readonly ordering_locked: boolean;
    readonly check_id: string | null;
    readonly party_size: number;
    /** The host's first name, from the session's guest ("Marcus"). */
    readonly host_name: string | null;
  };
  readonly venue_name: string;
  readonly venue_slug: string;
}

export async function roomGuestById(
  c: Queryable,
  venueId: string,
  id: string,
): Promise<RoomGuestRow | null> {
  const r = await c.query<{
    id: string;
    session_id: string;
    room_id: string;
    room_name: string;
    is_host: boolean;
    token_version: number;
    name: string | null;
    alcohol_cut_off_at: string | null;
    s_room_id: string;
    s_room_name: string;
    s_token_version: number;
    s_ended: boolean;
    room_code_enc: string | null;
    host_lock: boolean;
    ordering_locked: boolean;
    check_id: string | null;
    party_size: number;
    host_name: string | null;
    venue_name: string;
    venue_slug: string;
  }>(
    `select g.id, g.session_id, g.room_id, gr.name as room_name, g.is_host, g.token_version, g.name,
            to_json(g.alcohol_cut_off_at) #>> '{}' as alcohol_cut_off_at,
            s.room_id as s_room_id, sr.name as s_room_name, s.token_version as s_token_version,
            s.ended_at is not null as s_ended, s.room_code_enc, s.host_lock, s.ordering_locked, s.check_id,
            s.party_size, split_part(hg.name, ' ', 1) as host_name, v.name as venue_name, v.slug as venue_slug
       from room_guests g
       join room_sessions s on s.venue_id = g.venue_id and s.id = g.session_id
       join rooms gr on gr.venue_id = g.venue_id and gr.id = g.room_id
       join rooms sr on sr.venue_id = s.venue_id and sr.id = s.room_id
       join venues v on v.id = g.venue_id
       left join guests hg on hg.venue_id = s.venue_id and hg.id = s.guest_id
      where g.venue_id = $1 and g.id = $2 and g.left_at is null`,
    [venueId, id],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    session_id: row.session_id,
    room_id: row.room_id,
    room_name: row.room_name,
    is_host: row.is_host,
    token_version: row.token_version,
    name: row.name,
    alcohol_cut_off_at: row.alcohol_cut_off_at,
    session: {
      room_id: row.s_room_id,
      room_name: row.s_room_name,
      token_version: row.s_token_version,
      ended: row.s_ended,
      room_code_enc: row.room_code_enc,
      host_lock: row.host_lock,
      ordering_locked: row.ordering_locked,
      check_id: row.check_id,
      party_size: row.party_size,
      host_name: row.host_name,
    },
    venue_name: row.venue_name,
    venue_slug: row.venue_slug,
  };
}

export async function insertRoomGuest(
  c: Queryable,
  venueId: string,
  g: {
    sessionId: string;
    roomId: string;
    tokenHash: string;
    tokenVersion: number;
    isHost: boolean;
    at: string;
  },
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `insert into room_guests (venue_id, session_id, room_id, token_hash, token_version, is_host, joined_at, last_seen_at)
     values ($1, $2, $3, $4, $5, $6, $7, $7) returning id`,
    [venueId, g.sessionId, g.roomId, g.tokenHash, g.tokenVersion, g.isHost, g.at],
  );
  return r.rows[0]!.id;
}

/** A joined phone's fresh token after its session's version moved on (a move, a host lock, a new code). */
export async function refreshRoomGuest(
  c: Queryable,
  venueId: string,
  id: string,
  g: { tokenHash: string; tokenVersion: number; roomId: string; at: string },
): Promise<void> {
  await c.query(
    `update room_guests set token_hash = $3, token_version = $4, room_id = $5, last_seen_at = $6
      where venue_id = $1 and id = $2`,
    [venueId, id, g.tokenHash, g.tokenVersion, g.roomId, g.at],
  );
}

/**
 * A room's open session, for joining with its code. A practice session can't be joined: practice
 * never reaches a real guest (M7-03). The one exception is our own test venue (the
 * `synthetic.test_venue` flag, M8-18), where the synthetic check's phone joins its practice
 * walk-in: no real guest is ever there.
 */
export async function openSessionInRoom(
  c: Queryable,
  venueId: string,
  roomId: string,
): Promise<{
  id: string;
  room_code_hash: string | null;
  token_version: number;
  wrong_codes: number;
} | null> {
  const r = await c.query<{
    id: string;
    room_code_hash: string | null;
    token_version: number;
    wrong_codes: number;
  }>(
    `select id, room_code_hash, token_version, wrong_codes from room_sessions
      where venue_id = $1 and room_id = $2 and ended_at is null
        and (not training or exists (select 1 from venue_flags f
                                      where f.venue_id = $1 and f.flag = 'synthetic.test_venue' and f."on"))
      order by started_at desc limit 1`,
    [venueId, roomId],
  );
  return r.rows[0] ?? null;
}
