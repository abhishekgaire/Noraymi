import type { Queryable } from "./tenancy.js";

/**
 * Rooms and room states (M2-04; spec 04). Inside a venue transaction.
 */
export type RoomState = "available" | "in_use" | "wrap_up" | "cleaning" | "out_of_service";
export const roomStates: readonly RoomState[] = [
  "available",
  "in_use",
  "wrap_up",
  "cleaning",
  "out_of_service",
];

export interface RoomRow {
  readonly id: string;
  readonly name: string;
  readonly size_tier: string;
  readonly capacity_min: number;
  readonly capacity_max: number;
  readonly cleaning_min: number | null;
  readonly is_vip: boolean;
  readonly bookable_online: boolean;
  readonly archived_at: string | null;
  readonly state: RoomState;
  readonly state_reason: string | null;
  readonly state_since: string;
  readonly state_until: string | null;
}

const COLS = `r.id, r.name, r.size_tier, r.capacity_min, r.capacity_max, r.cleaning_min, r.is_vip,
  r.bookable_online, r.archived_at::text, coalesce(s.state, 'available') as state,
  s.reason as state_reason, coalesce(s.since, r.created_at)::text as state_since, s.until::text as state_until`;
const FROM = `from rooms r left join room_states s on s.venue_id = r.venue_id and s.room_id = r.id`;

/** The venue's rooms in the board's order (by name, numbers in order), live ones unless asked for all. */
export async function listRooms(
  c: Queryable,
  venueId: string,
  options: { includeArchived?: boolean } = {},
): Promise<RoomRow[]> {
  const r = await c.query<RoomRow>(
    `select ${COLS} ${FROM}
      where r.venue_id = $1 ${options.includeArchived ? "" : "and r.archived_at is null"}
      order by r.is_vip, nullif(regexp_replace(r.name, '\\D', '', 'g'), '')::int nulls last, r.name`,
    [venueId],
  );
  return r.rows;
}

export async function roomById(c: Queryable, venueId: string, id: string): Promise<RoomRow | null> {
  const r = await c.query<RoomRow>(`select ${COLS} ${FROM} where r.venue_id = $1 and r.id = $2`, [
    venueId,
    id,
  ]);
  return r.rows[0] ?? null;
}

export interface RoomInput {
  readonly name: string;
  readonly sizeTier: string;
  readonly capacityMin: number;
  readonly capacityMax: number;
  readonly cleaningMin: number | null;
  readonly isVip: boolean;
  readonly bookableOnline: boolean;
}

export async function createRoom(
  c: Queryable,
  venueId: string,
  input: RoomInput,
  at: string,
  id?: string,
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `insert into rooms (id, venue_id, name, size_tier, capacity_min, capacity_max, cleaning_min, is_vip, bookable_online)
       values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [
      id ?? null,
      venueId,
      input.name,
      input.sizeTier,
      input.capacityMin,
      input.capacityMax,
      input.cleaningMin,
      input.isVip,
      input.bookableOnline,
    ],
  );
  await c.query(
    `insert into room_states (venue_id, room_id, state, since) values ($1, $2, 'available', $3)`,
    [venueId, r.rows[0]!.id, at],
  );
  return r.rows[0]!.id;
}

export async function updateRoom(
  c: Queryable,
  venueId: string,
  id: string,
  patch: Partial<RoomInput> & { archived?: boolean },
  at: string,
): Promise<boolean> {
  const r = await c.query(
    `update rooms set
        name = coalesce($3, name),
        size_tier = coalesce($4, size_tier),
        capacity_min = coalesce($5, capacity_min),
        capacity_max = coalesce($6, capacity_max),
        cleaning_min = case when $7::boolean then $8::integer else cleaning_min end,
        is_vip = coalesce($9, is_vip),
        bookable_online = coalesce($10, bookable_online),
        archived_at = case when $11::boolean is null then archived_at when $11::boolean then coalesce(archived_at, $12::timestamptz) else null end
      where venue_id = $1 and id = $2`,
    [
      venueId,
      id,
      patch.name ?? null,
      patch.sizeTier ?? null,
      patch.capacityMin ?? null,
      patch.capacityMax ?? null,
      patch.cleaningMin !== undefined,
      patch.cleaningMin ?? null,
      patch.isVip ?? null,
      patch.bookableOnline ?? null,
      patch.archived ?? null,
      at,
    ],
  );
  return r.rowCount === 1;
}

export async function setRoomState(
  c: Queryable,
  venueId: string,
  roomId: string,
  input: {
    state: RoomState;
    reason?: string | null;
    until?: string | null;
    setBy?: string | undefined;
    at: string;
  },
): Promise<boolean> {
  const r = await c.query(
    `insert into room_states (venue_id, room_id, state, reason, since, until, set_by)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (venue_id, room_id) do update
         set state = excluded.state, reason = excluded.reason, since = excluded.since,
             until = excluded.until, set_by = excluded.set_by`,
    [
      venueId,
      roomId,
      input.state,
      input.reason ?? null,
      input.at,
      input.until ?? null,
      input.setBy ?? null,
    ],
  );
  return r.rowCount === 1;
}
