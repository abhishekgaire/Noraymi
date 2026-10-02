import { emitEvent, type Queryable } from "@west4/db";
import { ApiError } from "../http/errors.js";

/**
 * Merging two sessions (M4-28; Data model · room_sessions; no route and no
 * screen in phase 1): the second session's check_id points at the first's
 * check; its lines move across as `transfer_out` and `transfer_in` lines, and
 * its deposit or hold allocations move with them (the old one released, the
 * same amount on the first check), so both guarantees stay. Each session keeps
 * its own room and segments, and finalize bills every session on the check.
 * One transaction: the caller's.
 */
export async function mergeSessions(
  c: Queryable,
  venueId: string,
  input: { intoSessionId: string; fromSessionId: string; by: string; at: string },
) {
  if (input.intoSessionId === input.fromSessionId)
    throw new ApiError("invalid_request", "a session can't merge into itself");
  const sessions = await c.query<{
    id: string;
    check_id: string | null;
    ended: boolean;
    room: string;
    business_date: string;
  }>(
    `select s.id, s.check_id, s.ended_at is not null as ended, r.name as room, s.business_date::text
       from room_sessions s join rooms r on r.venue_id = s.venue_id and r.id = s.room_id
      where s.venue_id = $1 and s.id = any($2::uuid[]) order by s.id for update of s`,
    [venueId, [input.intoSessionId, input.fromSessionId]],
  );
  const into = sessions.rows.find((s) => s.id === input.intoSessionId);
  const from = sessions.rows.find((s) => s.id === input.fromSessionId);
  if (!into || !from) throw new ApiError("not_found", "no such session");
  if (into.ended || from.ended)
    throw new ApiError("invalid_request", "an ended session can't merge");
  if (!into.check_id || !from.check_id)
    throw new ApiError("invalid_request", "a session has no check");
  if (into.check_id === from.check_id) throw new ApiError("invalid_request", "already one check");
  const checks = await c.query<{ id: string; status: string }>(
    "select id, status from checks where venue_id = $1 and id = any($2::uuid[]) for update",
    [venueId, [into.check_id, from.check_id]],
  );
  if (checks.rows.some((k) => k.status !== "open"))
    throw new ApiError("invalid_request", "merge before either check is presented");

  // Each standing line moves: out of the second check, into the first, naming where it came from.
  const lines = await c.query<{
    id: string;
    kind: string;
    description: string;
    qty: number;
    unit_cents: string;
    amount_cents: string;
    tax_category: string | null;
    business_date: string;
  }>(
    `select l.id, l.kind, l.description, l.qty, l.unit_cents, l.amount_cents, l.tax_category, l.business_date::text
       from check_lines l
      where l.venue_id = $1 and l.check_id = $2 and l.reverses_id is null
        and not exists (select 1 from check_lines x where x.venue_id = l.venue_id and x.reverses_id = l.id)
      order by l.id`,
    [venueId, from.check_id],
  );
  for (const l of lines.rows) {
    const cents = Number(l.amount_cents);
    if (cents === 0) continue;
    await c.query(
      `insert into check_lines (venue_id, check_id, kind, description, qty, unit_cents, amount_cents, tax_category,
         reverses_id, business_date, added_by, added_at)
       values ($1, $2, 'transfer_out', $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        venueId,
        from.check_id,
        l.description,
        l.qty,
        -Number(l.unit_cents),
        -cents,
        l.tax_category,
        l.id,
        l.business_date,
        input.by,
        input.at,
      ],
    );
    await c.query(
      `insert into check_lines (venue_id, check_id, kind, description, qty, unit_cents, amount_cents, tax_category,
         business_date, added_by, added_at, reason)
       values ($1, $2, 'transfer_in', $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        venueId,
        into.check_id,
        l.description,
        l.qty,
        Number(l.unit_cents),
        cents,
        l.tax_category,
        l.business_date,
        input.by,
        input.at,
        `from ${from.room}`,
      ],
    );
  }

  // Deposits and holds move with them, so both guarantees stay.
  const allocations = await c.query<{
    id: string;
    payment_id: string;
    amount_cents: string;
    state: "in_progress" | "captured";
    follows_lines: boolean;
  }>(
    `select id, payment_id, amount_cents, state, follows_lines from payment_allocations
      where venue_id = $1 and check_id = $2 and kind = 'payment' and state in ('in_progress', 'captured')`,
    [venueId, from.check_id],
  );
  for (const a of allocations.rows) {
    await c.query(
      "update payment_allocations set state = 'released' where venue_id = $1 and id = $2",
      [venueId, a.id],
    );
    await c.query(
      `insert into payment_allocations (venue_id, payment_id, check_id, amount_cents, kind, state, follows_lines)
       values ($1, $2, $3, $4, 'payment', $5, $6)`,
      [venueId, a.payment_id, into.check_id, a.amount_cents, a.state, a.follows_lines],
    );
  }
  await c.query("update room_sessions set check_id = $3 where venue_id = $1 and id = $2", [
    venueId,
    from.id,
    into.check_id,
  ]);
  for (const check of [into.check_id, from.check_id])
    await emitEvent(c, { venueId, type: "check.updated", entityId: check, entityVersion: 0 });
  return { checkId: into.check_id, lines: lines.rows.length, allocations: allocations.rows.length };
}
