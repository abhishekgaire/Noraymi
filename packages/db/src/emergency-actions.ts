import type { Queryable } from "./tenancy.js";

/**
 * The Console's emergency path (M8-11; spec 02 · Support access; spec 13 · On
 * call). One of our staff asks for one listed action on one venue, with a
 * reason; a second person on our side approves it in their own Console
 * session (never the one who asked) before its time box ends, and only then
 * does it run. The row keeps both identities, the outcome and, for closing a
 * stuck night, the named fixes with their reasons.
 */
export type EmergencyStatus =
  "requested" | "declined" | "withdrawn" | "approved" | "done" | "failed";

export interface EmergencyFix {
  readonly kind: "clock_out_shift" | "clear_draft" | "expire_approval";
  readonly id: string;
  readonly reason: string;
}

export interface EmergencyActionRow {
  readonly id: string;
  readonly venue_id: string;
  readonly action: string;
  readonly target: string;
  readonly fixes: EmergencyFix[];
  readonly reason: string;
  readonly requested_by: string;
  readonly requested_by_name: string | null;
  readonly requested_at: string;
  readonly expires_at: string;
  readonly status: EmergencyStatus;
  readonly decided_by: string | null;
  readonly decided_by_name: string | null;
  readonly decided_at: string | null;
  readonly done_at: string | null;
  readonly result: Record<string, unknown> | null;
}

const ts = (col: string) => `to_json(e.${col}) #>> '{}' as ${col}`;
const COLS = [
  "e.id",
  "e.venue_id",
  "e.action",
  "e.target",
  "e.fixes",
  "e.reason",
  "e.requested_by",
  "r.name as requested_by_name",
  ts("requested_at"),
  ts("expires_at"),
  "e.status",
  "e.decided_by",
  "d.name as decided_by_name",
  ts("decided_at"),
  ts("done_at"),
  "e.result",
].join(", ");
const FROM = `emergency_actions e
  left join console_staff r on r.id = e.requested_by
  left join console_staff d on d.id = e.decided_by`;

/** Where a request stands: a waiting request past its time box has expired. */
export type EmergencyState = EmergencyStatus | "expired";

export function emergencyState(
  e: Pick<EmergencyActionRow, "status" | "expires_at">,
  atMs: number,
): EmergencyState {
  if (e.status === "requested" && Date.parse(e.expires_at) <= atMs) return "expired";
  return e.status;
}

export async function requestEmergencyAction(
  c: Queryable,
  input: {
    venueId: string;
    staffId: string;
    action: string;
    target: string;
    fixes: readonly EmergencyFix[];
    reason: string;
    at: string;
    minutes: number;
  },
): Promise<EmergencyActionRow> {
  const r = await c.query<{ id: string }>(
    `insert into emergency_actions (venue_id, action, target, fixes, reason, requested_by, requested_at, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $7::timestamptz + make_interval(mins => $8)) returning id`,
    [
      input.venueId,
      input.action,
      input.target,
      JSON.stringify(input.fixes),
      input.reason,
      input.staffId,
      input.at,
      input.minutes,
    ],
  );
  return (await emergencyAction(c, input.venueId, r.rows[0]!.id))!;
}

export async function emergencyAction(
  c: Queryable,
  venueId: string,
  id: string,
): Promise<EmergencyActionRow | null> {
  const r = await c.query<EmergencyActionRow>(
    `select ${COLS} from ${FROM} where e.venue_id = $1 and e.id = $2`,
    [venueId, id],
  );
  return r.rows[0] ?? null;
}

/** The venue's emergency actions, newest first (the last 50). */
export async function emergencyActions(
  c: Queryable,
  venueId: string,
): Promise<EmergencyActionRow[]> {
  const r = await c.query<EmergencyActionRow>(
    `select ${COLS} from ${FROM} where e.venue_id = $1 order by e.requested_at desc limit 50`,
    [venueId],
  );
  return r.rows;
}

/**
 * The second approver's answer to a waiting request, before it expires. The
 * one who asked can't answer their own (the table refuses it too). Returns
 * null when the request isn't waiting any more.
 */
export async function decideEmergencyAction(
  c: Queryable,
  input: {
    venueId: string;
    id: string;
    decision: "approve" | "decline";
    staffId: string;
    at: string;
  },
): Promise<EmergencyActionRow | null> {
  const r = await c.query(
    `update emergency_actions set status = $3, decided_by = $4, decided_at = $5
      where venue_id = $1 and id = $2 and status = 'requested' and requested_by <> $4
        and expires_at > $5::timestamptz`,
    [
      input.venueId,
      input.id,
      input.decision === "approve" ? "approved" : "declined",
      input.staffId,
      input.at,
    ],
  );
  if (r.rowCount === 0) return null;
  return emergencyAction(c, input.venueId, input.id);
}

/** The one who asked takes a waiting request back. */
export async function withdrawEmergencyAction(
  c: Queryable,
  input: { venueId: string; id: string; staffId: string },
): Promise<EmergencyActionRow | null> {
  const r = await c.query(
    `update emergency_actions set status = 'withdrawn'
      where venue_id = $1 and id = $2 and status = 'requested' and requested_by = $3`,
    [input.venueId, input.id, input.staffId],
  );
  if (r.rowCount === 0) return null;
  return emergencyAction(c, input.venueId, input.id);
}

/** An approved action's outcome: done or failed, with what happened. */
export async function finishEmergencyAction(
  c: Queryable,
  input: {
    venueId: string;
    id: string;
    ok: boolean;
    result: Record<string, unknown>;
    at: string;
  },
): Promise<EmergencyActionRow | null> {
  await c.query(
    `update emergency_actions set status = $3, done_at = $4, result = $5
      where venue_id = $1 and id = $2 and status = 'approved'`,
    [input.venueId, input.id, input.ok ? "done" : "failed", input.at, JSON.stringify(input.result)],
  );
  return emergencyAction(c, input.venueId, input.id);
}
