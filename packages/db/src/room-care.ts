import type { Queryable } from "./tenancy.js";

/** Room notes and lost and found (M2-19; spec 04 · room_notes, lost_items). */
export interface RoomNoteRow {
  readonly id: string;
  readonly room_id: string;
  readonly text: string;
  readonly added_by: string | null;
  readonly added_at: string;
}

export async function addRoomNote(
  c: Queryable,
  venueId: string,
  input: { roomId: string; text: string; addedBy: string | null; at: string },
): Promise<string> {
  const r = await c.query<{ id: string }>(
    "insert into room_notes (venue_id, room_id, text, added_by, added_at) values ($1, $2, $3, $4, $5) returning id",
    [venueId, input.roomId, input.text, input.addedBy, input.at],
  );
  return r.rows[0]!.id;
}

export async function roomNotes(c: Queryable, venueId: string): Promise<RoomNoteRow[]> {
  const r = await c.query<RoomNoteRow>(
    `select id, room_id, text, added_by, to_json(added_at) #>> '{}' as added_at from room_notes
      where venue_id = $1 and cleared_at is null order by added_at`,
    [venueId],
  );
  return r.rows;
}

export async function clearRoomNote(
  c: Queryable,
  venueId: string,
  id: string,
  at: string,
): Promise<boolean> {
  const r = await c.query(
    "update room_notes set cleared_at = $3 where venue_id = $1 and id = $2 and cleared_at is null",
    [venueId, id, at],
  );
  return r.rowCount === 1;
}

export interface LostItemRow {
  readonly id: string;
  readonly room_id: string | null;
  readonly room_name: string | null;
  readonly session_id: string | null;
  readonly description: string;
  readonly photo_file_id: string | null;
  readonly found_by: string;
  readonly found_by_name: string;
  readonly found_at: string;
  readonly kept_at: string;
  readonly claimed_by_name: string | null;
  readonly claimed_at: string | null;
  readonly handed_over_by: string | null;
  readonly disposed_at: string | null;
}

const LOST = `select l.id, l.room_id, r.name as room_name, l.session_id, l.description, l.photo_file_id,
    l.found_by, u.name as found_by_name, to_json(l.found_at) #>> '{}' as found_at, l.kept_at,
    l.claimed_by_name, to_json(l.claimed_at) #>> '{}' as claimed_at, l.handed_over_by,
    to_json(l.disposed_at) #>> '{}' as disposed_at
  from lost_items l join users u on u.id = l.found_by
  left join rooms r on r.venue_id = l.venue_id and r.id = l.room_id`;

export async function addLostItem(
  c: Queryable,
  venueId: string,
  input: {
    roomId: string | null;
    sessionId: string | null;
    description: string;
    photoFileId: string | null;
    foundBy: string;
    at: string;
    keptAt: string;
  },
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `insert into lost_items (venue_id, room_id, session_id, description, photo_file_id, found_by, found_at, kept_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [
      venueId,
      input.roomId,
      input.sessionId,
      input.description,
      input.photoFileId,
      input.foundBy,
      input.at,
      input.keptAt,
    ],
  );
  return r.rows[0]!.id;
}

export async function lostItemById(
  c: Queryable,
  venueId: string,
  id: string,
): Promise<LostItemRow | null> {
  const r = await c.query<LostItemRow>(`${LOST} where l.venue_id = $1 and l.id = $2`, [
    venueId,
    id,
  ]);
  return r.rows[0] ?? null;
}

/** The log, newest first: still kept, or everything when `all`. */
export async function lostItems(
  c: Queryable,
  venueId: string,
  all: boolean,
): Promise<LostItemRow[]> {
  const r = await c.query<LostItemRow>(
    `${LOST} where l.venue_id = $1 ${all ? "" : "and l.claimed_at is null and l.disposed_at is null"}
      order by l.found_at desc limit 200`,
    [venueId],
  );
  return r.rows;
}

export async function updateLostItem(
  c: Queryable,
  venueId: string,
  id: string,
  change: {
    keptAt?: string;
    claim?: { name: string; handedOverBy: string; at: string };
    disposedAt?: string;
  },
): Promise<void> {
  if (change.keptAt !== undefined)
    await c.query("update lost_items set kept_at = $3 where venue_id = $1 and id = $2", [
      venueId,
      id,
      change.keptAt,
    ]);
  if (change.claim)
    await c.query(
      `update lost_items set claimed_by_name = $3, handed_over_by = $4, claimed_at = $5
        where venue_id = $1 and id = $2 and claimed_at is null`,
      [venueId, id, change.claim.name, change.claim.handedOverBy, change.claim.at],
    );
  if (change.disposedAt !== undefined)
    await c.query(
      "update lost_items set disposed_at = $3 where venue_id = $1 and id = $2 and disposed_at is null",
      [venueId, id, change.disposedAt],
    );
}
