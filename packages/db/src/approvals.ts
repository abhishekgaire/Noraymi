import type { Queryable } from "./tenancy.js";

/**
 * Approvals (M2-15). Inside a venue transaction. `managerOnDuty` is the one
 * place every caller asks who the manager on duty is (approvals, room-order
 * escalation, alerts). Since M7-01 it's the person on an open Manager-duty
 * shift. With two managers on the clock, the handover (M7-05) will decide;
 * until it lands, the cautious default keeps the one who clocked in first.
 */
export async function managerOnDuty(c: Queryable, venueId: string): Promise<string | null> {
  const r = await c.query<{ user_id: string }>(
    `select m.user_id from shifts s join memberships m on m.venue_id = s.venue_id and m.id = s.membership_id
      where s.venue_id = $1 and s.ended_at is null and s.duty = 'manager'
        and m.status = 'active' and m.role in ('owner', 'manager')
      order by s.started_at, s.id limit 1`,
    [venueId],
  );
  return r.rows[0]?.user_id ?? null;
}

export async function approvalPeople(
  c: Queryable,
  venueId: string,
): Promise<{ id: string; role: string; name: string }[]> {
  const r = await c.query<{ id: string; role: string; name: string }>(
    `select m.user_id as id, m.role, u.name from memberships m join users u on u.id = m.user_id
      where m.venue_id = $1 and m.status = 'active' and m.role in ('owner', 'manager', 'bartender', 'front_desk', 'staff')
      order by array_position(array['owner','manager','bartender','front_desk','staff'], m.role), u.name`,
    [venueId],
  );
  return r.rows;
}

export interface ApprovalRow {
  readonly id: string;
  readonly kind: string;
  readonly target_kind: string;
  readonly target_id: string;
  readonly amount_cents: number | null;
  readonly reason: string;
  readonly payload: Record<string, unknown>;
  readonly requested_by: string;
  readonly requested_by_name: string;
  readonly requested_device_id: string | null;
  readonly requested_at: string;
  readonly routed_to: string;
  readonly routed_to_name: string;
  readonly status: "pending" | "approved" | "declined" | "expired";
  readonly decided_at: string | null;
  /** From a practice check (training mode, M7-03): marked TRAINING in the inbox, and never counted. */
  readonly training: boolean;
}

const COLS = `a.id, a.kind, a.target_kind, a.target_id, a.amount_cents::int as amount_cents, a.reason, a.payload,
  a.requested_by, rq.name as requested_by_name, a.requested_device_id, to_json(a.requested_at) #>> '{}' as requested_at,
  a.routed_to, rt.name as routed_to_name, a.status, to_json(a.decided_at) #>> '{}' as decided_at, a.training`;
const FROM = `from approvals a join users rq on rq.id = a.requested_by join users rt on rt.id = a.routed_to`;

export async function insertApproval(
  c: Queryable,
  venueId: string,
  input: {
    kind: string;
    targetKind: string;
    targetId: string;
    amountCents: number | null;
    reason: string;
    payload: Record<string, unknown>;
    requestedBy: string;
    requestedDeviceId: string | null;
    requestedAt: string;
    routedTo: string;
  },
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `insert into approvals (venue_id, kind, target_kind, target_id, amount_cents, reason, payload, requested_by,
       requested_device_id, requested_at, routed_to)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
    [
      venueId,
      input.kind,
      input.targetKind,
      input.targetId,
      input.amountCents,
      input.reason,
      JSON.stringify(input.payload),
      input.requestedBy,
      input.requestedDeviceId,
      input.requestedAt,
      input.routedTo,
    ],
  );
  return r.rows[0]!.id;
}

export async function approvalById(
  c: Queryable,
  venueId: string,
  id: string,
  lock = false,
): Promise<ApprovalRow | null> {
  const r = await c.query<ApprovalRow>(
    `select ${COLS} ${FROM} where a.venue_id = $1 and a.id = $2${lock ? " for update of a" : ""}`,
    [venueId, id],
  );
  return r.rows[0] ?? null;
}

/** The inbox: what's waiting for this person, or what they asked for. */
export async function approvalsFor(
  c: Queryable,
  venueId: string,
  userId: string,
  status: string | null,
): Promise<ApprovalRow[]> {
  const r = await c.query<ApprovalRow>(
    `select ${COLS} ${FROM} where a.venue_id = $1 and (a.routed_to = $2 or a.requested_by = $2)
       and ($3::text is null or a.status = $3) order by a.requested_at desc limit 100`,
    [venueId, userId, status],
  );
  return r.rows;
}

export async function decideApproval(
  c: Queryable,
  venueId: string,
  id: string,
  input: {
    status: "approved" | "declined" | "expired";
    approverId: string | null;
    deviceId: string | null;
    at: string;
  },
): Promise<void> {
  await c.query(
    `update approvals set status = $3, approver_id = $4, decided_device_id = $5, decided_at = $6
      where venue_id = $1 and id = $2 and status = 'pending'`,
    [venueId, id, input.status, input.approverId, input.deviceId, input.at],
  );
}
