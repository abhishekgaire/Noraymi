import type { Queryable } from "@west4/db";
import {
  PART_STATES,
  STATUS_PARTS,
  scrubText,
  type PartState,
  type PublicStatus,
  type StatusPart,
} from "@west4/shared";

/**
 * The public status page's parts (M8-16; spec 13 · Watching production): ordering, payments,
 * printing and texts. Each has the state our jobs set (auto: the vendor-health sweep for payments
 * and texts today; M8-17's burn alerts and M8-18's synthetic checks later) and, over it, what an
 * operator posts (an incident, a drill, maintenance) with `status:set`. Platform rows: no venue
 * is ever named, and a note is scrubbed of personal data before it's stored.
 */

interface Row {
  part: StatusPart;
  auto_state: PartState;
  auto_note: string | null;
  auto_since: Date | null;
  operator_state: PartState | null;
  operator_note: string | null;
  operator_since: Date | null;
  updated_at: Date;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export async function readStatus(q: Queryable): Promise<PublicStatus> {
  const r = await q.query<Row>(
    `select part, auto_state, auto_note, auto_since, operator_state, operator_note, operator_since,
            updated_at
       from status_parts`,
  );
  const byPart = new Map(r.rows.map((row) => [row.part, row]));
  let updated = 0;
  const parts = STATUS_PARTS.map((part) => {
    const row = byPart.get(part);
    if (!row) return { part, state: "operational" as const, note: null, since: null };
    updated = Math.max(updated, row.updated_at.getTime());
    return row.operator_state
      ? {
          part,
          state: row.operator_state,
          note: row.operator_note,
          since: iso(row.operator_since),
        }
      : { part, state: row.auto_state, note: row.auto_note, since: iso(row.auto_since) };
  });
  return { parts, updated_at: new Date(updated).toISOString() };
}

export function isPart(p: string): p is StatusPart {
  return (STATUS_PARTS as readonly string[]).includes(p);
}
export function isPartState(s: string): s is PartState {
  return (PART_STATES as readonly string[]).includes(s);
}

/** What a job learned; `since` moves only when the state changes. Answers whether it changed. */
export async function setAutoStatus(
  q: Queryable,
  part: StatusPart,
  state: PartState,
  note: string | null,
  at: string,
): Promise<boolean> {
  const r = await q.query(
    `update status_parts
        set auto_state = $2, auto_note = $3, auto_since = $4, updated_at = now()
      where part = $1 and (auto_state <> $2 or auto_note is distinct from $3)`,
    [part, state, note === null ? null : scrubText(note), at],
  );
  return (r.rowCount ?? 0) > 0;
}

/** An operator's post over the jobs' state, or `null` to clear it and let the jobs' state show. */
export async function setOperatorStatus(
  q: Queryable,
  part: StatusPart,
  state: PartState | null,
  note: string | null,
  by: string,
  at: string,
): Promise<void> {
  await q.query(
    `update status_parts
        set operator_state = $2, operator_note = $3, operator_since = $4, operator_by = $5,
            updated_at = now()
      where part = $1`,
    [
      part,
      state,
      state === null || note === null ? null : scrubText(note).slice(0, 280),
      state === null ? null : at,
      by,
    ],
  );
}
