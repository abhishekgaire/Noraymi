import type { Queryable } from "./tenancy.js";

/** Room faults (M2-16; spec 04 · room_faults). */
export interface FaultRow {
  readonly id: string;
  readonly room_id: string;
  readonly session_id: string | null;
  readonly text: string;
  readonly reported_by: string | null;
  readonly reported_by_name: string | null;
  readonly reported_at: string;
  readonly out_of_service: boolean;
  readonly pause_segment_id: string | null;
  readonly comp_line_id: number | null;
  readonly fixed_by: string | null;
  readonly fixed_at: string | null;
}

const COLS = `f.id, f.room_id, f.session_id, f.text, f.reported_by, u.name as reported_by_name,
  to_json(f.reported_at) #>> '{}' as reported_at, f.out_of_service, f.pause_segment_id,
  f.comp_line_id::int as comp_line_id, f.fixed_by, to_json(f.fixed_at) #>> '{}' as fixed_at`;
const FROM = "from room_faults f left join users u on u.id = f.reported_by";

export async function insertFault(
  c: Queryable,
  venueId: string,
  input: {
    roomId: string;
    sessionId: string | null;
    text: string;
    reportedBy: string | null;
    reportedAt: string;
    outOfService: boolean;
  },
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `insert into room_faults (venue_id, room_id, session_id, text, reported_by, reported_at, out_of_service)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      venueId,
      input.roomId,
      input.sessionId,
      input.text,
      input.reportedBy,
      input.reportedAt,
      input.outOfService,
    ],
  );
  return r.rows[0]!.id;
}

export async function faultById(
  c: Queryable,
  venueId: string,
  id: string,
  lock = false,
): Promise<FaultRow | null> {
  const r = await c.query<FaultRow>(
    `select ${COLS} ${FROM} where f.venue_id = $1 and f.id = $2${lock ? " for update of f" : ""}`,
    [venueId, id],
  );
  return r.rows[0] ?? null;
}

/** The open (unfixed) faults of the venue's rooms, oldest first. */
export async function openFaults(c: Queryable, venueId: string): Promise<FaultRow[]> {
  const r = await c.query<FaultRow>(
    `select ${COLS} ${FROM} where f.venue_id = $1 and f.fixed_at is null order by f.reported_at`,
    [venueId],
  );
  return r.rows;
}

export async function linkFault(
  c: Queryable,
  venueId: string,
  id: string,
  link: { pauseSegmentId?: string; compLineId?: number },
): Promise<void> {
  await c.query(
    `update room_faults set pause_segment_id = coalesce($3, pause_segment_id), comp_line_id = coalesce($4, comp_line_id)
      where venue_id = $1 and id = $2`,
    [venueId, id, link.pauseSegmentId ?? null, link.compLineId ?? null],
  );
}

export async function fixFault(
  c: Queryable,
  venueId: string,
  id: string,
  input: { fixedBy: string; at: string },
): Promise<boolean> {
  const r = await c.query(
    "update room_faults set fixed_by = $3, fixed_at = $4 where venue_id = $1 and id = $2 and fixed_at is null",
    [venueId, id, input.fixedBy, input.at],
  );
  return r.rowCount === 1;
}
