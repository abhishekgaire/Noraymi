import { addCheckLine, emitEvent, insertPrintJob, type Queryable } from "@west4/db";
import { businessDate } from "@west4/rules";
import type { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { venueClock } from "../rooms/assignment.js";
import { kitchenOn } from "./module.js";

/**
 * Send to kitchen (K-05; Kitchen and food · Ordering food, D99). Food staff ring goes on the check
 * exactly when a drink would and reads "Not sent" until someone taps Send to kitchen: one kitchen
 * ticket for the lines picked, each line marked `kitchen_sent_at` and `kitchen_sent_by`, never sent
 * twice. Food that's Not sent comes off freely (logged as a void line with no approval); sent food
 * only through the fix panel's void.
 */
export interface FoodLine {
  readonly line_id: number;
  readonly order_item_id: string;
  /** What's left of the line after voids and comps taken off it. */
  readonly open_qty: number;
  readonly rung_at: string;
  readonly sent_at: string | null;
  readonly sent_by: string | null;
  readonly kitchen_note: string | null;
  readonly allergy: boolean;
  /** The kitchen ticket that carried it, for Reprint. */
  readonly job_id: string | null;
}

/** The check's food lines (item lines whose order item is station kitchen), in order. */
export async function foodLines(
  c: Queryable,
  venueId: string,
  checkId: string,
  opts: { lock?: boolean; lineIds?: readonly number[] } = {},
): Promise<FoodLine[]> {
  const r = await c.query<{
    line_id: string;
    order_item_id: string;
    open_qty: string;
    rung_at: string;
    sent_at: string | null;
    sent_by: string | null;
    kitchen_note: string | null;
    allergy: boolean;
    job_id: string | null;
  }>(
    `select l.id as line_id, oi.id as order_item_id,
            l.qty - coalesce((select sum(x.qty) from check_lines x
                               where x.venue_id = l.venue_id and x.reverses_id = l.id), 0) as open_qty,
            to_json(l.added_at) #>> '{}' as rung_at,
            to_json(oi.kitchen_sent_at) #>> '{}' as sent_at,
            (select u.name from users u where u.id = oi.kitchen_sent_by) as sent_by,
            oi.kitchen_note, oi.kitchen_note_allergy as allergy,
            (select j.id from print_jobs j
              where j.venue_id = l.venue_id and j.check_id = l.check_id and j.reprint_of is null
                and j.payload->'line_ids' @> to_jsonb(l.id) limit 1) as job_id
       from check_lines l
       join order_items oi on oi.venue_id = l.venue_id and oi.id = l.source_id
      where l.venue_id = $1 and l.check_id = $2 and l.kind = 'item' and oi.station = 'kitchen'
        ${opts.lineIds ? "and l.id = any($3::bigint[])" : ""}
      order by l.id
      ${opts.lock ? "for update of oi" : ""}`,
    opts.lineIds ? [venueId, checkId, opts.lineIds] : [venueId, checkId],
  );
  return r.rows.map((x) => ({
    line_id: Number(x.line_id),
    order_item_id: x.order_item_id,
    open_qty: Number(x.open_qty),
    rung_at: x.rung_at,
    sent_at: x.sent_at,
    sent_by: x.sent_by,
    kitchen_note: x.kitchen_note,
    allergy: x.allergy,
    job_id: x.job_id,
  }));
}

/** The kitchen ticket's heading: the room ("Room 9"), the tab ("Bar · Jess P.") or the quick sale's name. */
async function ticketName(
  c: Queryable,
  venueId: string,
  checkId: string,
  kind: string,
  name: string | null,
): Promise<string> {
  const room = await c.query<{ name: string }>(
    `select r.name from checks k join room_sessions s on s.venue_id = k.venue_id and s.id = k.room_session_id
       join rooms r on r.venue_id = s.venue_id and r.id = s.room_id
      where k.venue_id = $1 and k.id = $2`,
    [venueId, checkId],
  );
  if (room.rows[0]) return room.rows[0].name;
  const tab = await c.query<{ name: string }>(
    "select name from tabs where venue_id = $1 and check_id = $2",
    [venueId, checkId],
  );
  if (tab.rows[0]) return `Bar · ${tab.rows[0].name}`;
  if (kind === "quick") {
    if (!name)
      throw new ApiError("invalid_request", "a quick sale's food needs a name or a label", {
        details: { reason: "name_required" },
      });
    return `Bar · ${name}`;
  }
  return "Bar";
}

export interface SendLine {
  readonly line_id: number;
  /** Absent keeps the note already on the line (one given when the round was sent). */
  readonly kitchen_note?: string | null | undefined;
  readonly kitchen_note_allergy?: boolean | undefined;
}

export async function sendToKitchen(
  c: Queryable,
  venueId: string,
  input: {
    checkId: string;
    lines: readonly SendLine[];
    name: string | null;
    userId: string;
    now: Temporal.Instant;
  },
) {
  if (!(await kitchenOn(c, venueId)))
    throw new ApiError("invalid_request", "Kitchen & food is off", {
      details: { reason: "kitchen_off" },
    });
  const check = (
    await c.query<{ status: string; kind: string; training: boolean }>(
      "select status, kind, training from checks where venue_id = $1 and id = $2 for update",
      [venueId, input.checkId],
    )
  ).rows[0];
  if (!check) throw new ApiError("not_found", "no such check");
  if (check.status === "void")
    throw new ApiError("ordering_closed", "this check is void", {
      details: { reason: "void" },
    });
  const ids = [...new Set(input.lines.map((l) => l.line_id))];
  if (ids.length === 0 || ids.length !== input.lines.length)
    throw new ApiError("invalid_request", "send each food line once");
  // The lines are locked first, so two screens sending at once print one ticket.
  const found = await foodLines(c, venueId, input.checkId, { lock: true, lineIds: ids });
  if (found.length !== ids.length)
    throw new ApiError("invalid_request", "only food on this check goes to the kitchen", {
      details: { reason: "not_food" },
    });
  const sent = found.filter((f) => f.sent_at !== null || f.open_qty <= 0);
  if (sent.length > 0)
    throw new ApiError("version_conflict", "some of this food is already sent to the kitchen", {
      details: { reason: "already_sent", line_ids: sent.map((s) => s.line_id) },
    });
  const name = input.name?.trim() ? input.name.trim() : null;
  const heading = await ticketName(c, venueId, input.checkId, check.kind, name);
  const who = (
    await c.query<{ name: string }>("select name from users where id = $1", [input.userId])
  ).rows[0]?.name;
  const at = input.now.toString();
  for (const l of input.lines) {
    const f = found.find((x) => x.line_id === l.line_id)!;
    const note =
      l.kitchen_note === undefined
        ? f.kitchen_note
        : l.kitchen_note?.trim()
          ? l.kitchen_note.trim()
          : null;
    const allergy =
      note !== null && (l.kitchen_note_allergy === undefined ? f.allergy : l.kitchen_note_allergy);
    await c.query(
      `update order_items set kitchen_sent_at = $3, kitchen_sent_by = $4, kitchen_note = $5,
              kitchen_note_allergy = $6
        where venue_id = $1 and id = $2`,
      [venueId, f.order_item_id, at, input.userId, note, allergy],
    );
  }
  const items = await c.query<{
    id: string;
    qty: string;
    name_snapshot: string;
    options: { name: string }[] | null;
    notes: string | null;
    kitchen_note: string | null;
    kitchen_note_allergy: boolean;
  }>(
    `select l.id, oi.name_snapshot, oi.options, oi.notes, oi.kitchen_note, oi.kitchen_note_allergy,
            l.qty - coalesce((select sum(x.qty) from check_lines x
                               where x.venue_id = l.venue_id and x.reverses_id = l.id), 0) as qty
       from check_lines l join order_items oi on oi.venue_id = l.venue_id and oi.id = l.source_id
      where l.venue_id = $1 and l.check_id = $2 and l.id = any($3::bigint[]) order by l.id`,
    [venueId, input.checkId, ids],
  );
  const jobId = await insertPrintJob(c, venueId, {
    checkId: input.checkId,
    kind: "ticket",
    station: "kitchen",
    createdAt: at,
    payload: {
      kitchen: true,
      check_id: input.checkId,
      room: heading,
      remake: false,
      sent_by: who ?? null,
      sent_at: at,
      ...(check.training ? { training: true } : {}),
      line_ids: ids,
      lines: items.rows.map((i) => ({
        qty: Number(i.qty),
        name: i.name_snapshot,
        options: (i.options ?? []).map((o) => o.name),
        notes: i.notes,
        kitchen_note: i.kitchen_note,
        allergy: i.kitchen_note_allergy,
      })),
    },
  });
  await emitEvent(c, { venueId, type: "check.updated", entityId: input.checkId, entityVersion: 0 });
  return {
    job_id: jobId,
    sent_at: at,
    sent_by: who ?? null,
    ticket: heading,
    line_ids: ids,
  };
}

/**
 * Food that's Not sent comes off with no reason and no approval, because the kitchen never saw it
 * (K-05). The removal is a void line with who and when, and doesn't count toward the person's
 * reason-only limit. Sent food answers `kitchen_sent`: it comes off only by the fix panel's void.
 */
export async function removeUnsentFood(
  c: Queryable,
  venueId: string,
  input: { checkId: string; lineId: number; userId: string; now: Temporal.Instant },
) {
  const check = (
    await c.query<{ status: string }>(
      "select status from checks where venue_id = $1 and id = $2 for update",
      [venueId, input.checkId],
    )
  ).rows[0];
  if (!check) throw new ApiError("not_found", "no such check");
  if (check.status !== "open" && check.status !== "reopened")
    throw new ApiError("ordering_closed", "this check is closed to changes");
  const f = (
    await foodLines(c, venueId, input.checkId, { lock: true, lineIds: [input.lineId] })
  )[0];
  if (!f) throw new ApiError("not_found", "no such food line on this check");
  if (f.sent_at !== null)
    throw new ApiError("invalid_request", "this food is sent: void it from the fix panel", {
      details: { reason: "kitchen_sent" },
    });
  if (f.open_qty <= 0)
    throw new ApiError("invalid_request", "this line is already off the check", {
      details: { reason: "removed" },
    });
  const line = (
    await c.query<{ description: string; unit_cents: string; tax_category: string | null }>(
      "select description, unit_cents, tax_category from check_lines where venue_id = $1 and id = $2",
      [venueId, input.lineId],
    )
  ).rows[0]!;
  const v = await venueClock(c, venueId);
  const night = businessDate(input.now, v.timeZone, v.dayCutover).businessDate.toString();
  const id = await addCheckLine(c, venueId, input.checkId, {
    kind: "void",
    description: `VOID · ${line.description}`,
    qty: f.open_qty,
    unitCents: -Number(line.unit_cents),
    amountCents: -Number(line.unit_cents) * f.open_qty,
    taxCategory: line.tax_category,
    businessDate: night,
    reversesId: input.lineId,
    made: false,
    reason: "Not sent to the kitchen",
    addedBy: input.userId,
    approvedBy: null,
    addedAt: input.now.toString(),
  });
  await emitEvent(c, { venueId, type: "check.updated", entityId: input.checkId, entityVersion: 0 });
  return { line_id: id };
}
