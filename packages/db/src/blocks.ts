import type { Temporal } from "@west4/shared";
import type { Queryable } from "./tenancy.js";

/**
 * Room blocks (M2-05; spec 04). Inside a venue transaction. The exclusion
 * constraint refuses an overlap; that refusal comes back as RoomNotFree.
 */
export type BlockKind = "booking" | "hold" | "session" | "cleaning" | "out_of_service" | "buyout";

export interface BlockRow {
  readonly id: string;
  readonly room_id: string;
  readonly kind: BlockKind;
  readonly ref_id: string | null;
  readonly starts_at: string;
  /** null: open-ended, until staff end it. */
  readonly ends_at: string | null;
  readonly expires_at: string | null;
}

export class RoomNotFree extends Error {
  constructor(readonly roomId: string) {
    super("that room already has something in that time");
    this.name = "RoomNotFree";
  }
}

const COLS = `id, room_id, kind, ref_id, to_json(lower(period)) #>> '{}' as starts_at,
  to_json(upper(period)) #>> '{}' as ends_at, to_json(expires_at) #>> '{}' as expires_at`;

export async function addBlock(
  c: Queryable,
  input: {
    venueId: string;
    roomId: string;
    kind: BlockKind;
    from: Temporal.Instant;
    to: Temporal.Instant | null;
    refId?: string | null;
    expiresAt?: Temporal.Instant | null;
    id?: string;
  },
): Promise<BlockRow> {
  try {
    const r = await c.query<BlockRow>(
      `insert into room_blocks (id, venue_id, room_id, kind, period, ref_id, expires_at)
         values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, tstzrange($5::timestamptz, $6::timestamptz, '[)'), $7, $8)
         returning ${COLS}`,
      [
        input.id ?? null,
        input.venueId,
        input.roomId,
        input.kind,
        input.from.toString(),
        input.to?.toString() ?? null,
        input.refId ?? null,
        input.expiresAt?.toString() ?? null,
      ],
    );
    return r.rows[0]!;
  } catch (e) {
    if ((e as { code?: string }).code === "23P01") throw new RoomNotFree(input.roomId);
    throw e;
  }
}

/** Every block that touches [from, to), open-ended ones included. */
export async function blocksBetween(
  c: Queryable,
  venueId: string,
  from: Temporal.Instant,
  to: Temporal.Instant | null,
): Promise<BlockRow[]> {
  const r = await c.query<BlockRow>(
    `select ${COLS} from room_blocks
      where venue_id = $1 and period && tstzrange($2::timestamptz, $3::timestamptz, '[)')
      order by lower(period)`,
    [venueId, from.toString(), to?.toString() ?? null],
  );
  return r.rows;
}

export async function blockById(
  c: Queryable,
  venueId: string,
  id: string,
): Promise<BlockRow | null> {
  const r = await c.query<BlockRow>(
    `select ${COLS} from room_blocks where venue_id = $1 and id = $2`,
    [venueId, id],
  );
  return r.rows[0] ?? null;
}

/** Moves a block's end (a session extended, cleaning finished). RoomNotFree on an overlap. */
export async function setBlockEnd(
  c: Queryable,
  venueId: string,
  id: string,
  to: Temporal.Instant | null,
): Promise<BlockRow | null> {
  try {
    const r = await c.query<BlockRow>(
      `update room_blocks set period = tstzrange(lower(period), $3::timestamptz, '[)')
        where venue_id = $1 and id = $2 returning ${COLS}`,
      [venueId, id, to?.toString() ?? null],
    );
    return r.rows[0] ?? null;
  } catch (e) {
    if ((e as { code?: string }).code === "23P01") throw new RoomNotFree(id);
    throw e;
  }
}

/** Moves a block to another room (a booking reassigned). RoomNotFree on an overlap. */
export async function moveBlock(
  c: Queryable,
  venueId: string,
  id: string,
  roomId: string,
): Promise<BlockRow | null> {
  try {
    const r = await c.query<BlockRow>(
      `update room_blocks set room_id = $3 where venue_id = $1 and id = $2 returning ${COLS}`,
      [venueId, id, roomId],
    );
    return r.rows[0] ?? null;
  } catch (e) {
    if ((e as { code?: string }).code === "23P01") throw new RoomNotFree(roomId);
    throw e;
  }
}

export async function releaseBlock(c: Queryable, id: string): Promise<boolean> {
  const r = await c.query<{ released: boolean }>("select release_room_block($1) as released", [id]);
  return r.rows[0]?.released ?? false;
}

/** Deletes the venue's lapsed holds; returns the rooms they freed. */
export async function expireHolds(c: Queryable, now: Temporal.Instant): Promise<string[]> {
  const r = await c.query<{ expire_room_holds: string }>("select expire_room_holds($1)", [
    now.toString(),
  ]);
  return r.rows.map((x) => x.expire_room_holds);
}
