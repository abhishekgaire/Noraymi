import { emitEvent, insertPrintJob, moduleOn, readSetting, type Queryable } from "@west4/db";
import { businessDate } from "@west4/rules";
import { Temporal } from "@west4/shared";
import { venueClock } from "../rooms/assignment.js";

/**
 * Kitchen screen (P-17; module kitchen_screen, off by default). Every kitchen ticket goes through
 * here: the printer gets it as before, and while the screen is on a `kitchen_tickets` row keeps the
 * same content for the screen, oldest first, until Done bumps it. With the screen on, the venue can
 * turn the printer off (`kitchenScreen.print`, on by default); with the screen off it always prints.
 */
export async function queueKitchenTicket(
  c: Queryable,
  venueId: string,
  t: {
    readonly orderId?: string | null;
    readonly checkId?: string | null;
    readonly payload: Record<string, unknown>;
    readonly createdAt: string;
  },
): Promise<string | null> {
  const screen = await moduleOn(c, venueId, "kitchen_screen");
  const v = await venueClock(c, venueId);
  const night = businessDate(
    Temporal.Instant.from(t.createdAt),
    v.timeZone,
    v.dayCutover,
  ).businessDate;
  const s = screen ? await readSetting(c, venueId, "kitchenScreen", night) : null;
  const print = !screen || s?.value.print !== false;
  const jobId = print
    ? await insertPrintJob(c, venueId, {
        orderId: t.orderId ?? null,
        checkId: t.checkId ?? null,
        kind: "ticket",
        station: "kitchen",
        createdAt: t.createdAt,
        payload: t.payload,
      })
    : null;
  if (screen) {
    const r = await c.query<{ id: string }>(
      `insert into kitchen_tickets (venue_id, order_id, check_id, print_job_id, business_date, payload, training, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [
        venueId,
        t.orderId ?? null,
        t.checkId ?? null,
        jobId,
        night.toString(),
        JSON.stringify(t.payload),
        t.payload["training"] === true,
        t.createdAt,
      ],
    );
    await emitEvent(c, {
      venueId,
      type: "kitchen.ticket",
      entityId: r.rows[0]!.id,
      audience: "staff",
    });
  }
  return jobId;
}

export interface KitchenTicket {
  readonly id: string;
  readonly created_at: string;
  readonly done_at: string | null;
  readonly room: string | null;
  readonly remake: boolean;
  readonly after_outage: boolean;
  readonly training: boolean;
  readonly by: string | null;
  readonly lines: readonly {
    qty: number;
    name: string;
    options: readonly string[];
    notes: string | null;
    kitchen_note: string | null;
    allergy: boolean;
  }[];
}

type Row = {
  id: string;
  created_at: string;
  done_at: string | null;
  payload: Record<string, unknown>;
  training: boolean;
};

const shape = (r: Row): KitchenTicket => {
  const p = r.payload;
  const lines = Array.isArray(p["lines"]) ? (p["lines"] as Record<string, unknown>[]) : [];
  return {
    id: r.id,
    created_at: r.created_at,
    done_at: r.done_at,
    room: typeof p["room"] === "string" ? p["room"] : null,
    remake: p["remake"] === true,
    after_outage: p["after_outage"] === true,
    training: r.training,
    by:
      typeof p["sent_by"] === "string"
        ? p["sent_by"]
        : typeof p["accepted_by"] === "string"
          ? p["accepted_by"]
          : null,
    lines: lines.map((l) => ({
      qty: Number(l["qty"] ?? 1),
      name: String(l["name"] ?? ""),
      options: Array.isArray(l["options"]) ? (l["options"] as unknown[]).map(String) : [],
      notes: typeof l["notes"] === "string" ? l["notes"] : null,
      kitchen_note: typeof l["kitchen_note"] === "string" ? l["kitchen_note"] : null,
      allergy: l["allergy"] === true,
    })),
  };
};

const COLS = `id, to_json(created_at) #>> '{}' as created_at, to_json(done_at) #>> '{}' as done_at,
  payload, training`;

/** The open tickets, oldest first: what the kitchen hasn't bumped yet, whatever night it came from. */
export async function openKitchenTickets(c: Queryable, venueId: string): Promise<KitchenTicket[]> {
  const r = await c.query<Row>(
    `select ${COLS} from kitchen_tickets where venue_id = $1 and done_at is null
      order by created_at, id limit 200`,
    [venueId],
  );
  return r.rows.map(shape);
}

/** Tonight's bumped tickets, newest first: what the bar is told is up. */
export async function doneKitchenTickets(
  c: Queryable,
  venueId: string,
  night: string,
): Promise<KitchenTicket[]> {
  const r = await c.query<Row>(
    `select ${COLS} from kitchen_tickets
      where venue_id = $1 and business_date = $2 and done_at is not null
      order by done_at desc, id limit 30`,
    [venueId, night],
  );
  return r.rows.map(shape);
}

/**
 * Done (P-17): bumps the ticket off the screen and tells the bar. Doing it twice answers the first
 * Done, so a kitchen screen replaying its offline taps never moves the time.
 */
export async function bumpKitchenTicket(
  c: Queryable,
  venueId: string,
  input: { ticketId: string; at: string; deviceId: string | null; userId: string | null },
): Promise<KitchenTicket | null> {
  const bumped = await c.query(
    `update kitchen_tickets set done_at = $3, done_device_id = $4, done_by = $5
      where venue_id = $1 and id = $2 and done_at is null`,
    [venueId, input.ticketId, input.at, input.deviceId, input.userId],
  );
  const r = await c.query<Row>(
    `select ${COLS} from kitchen_tickets where venue_id = $1 and id = $2`,
    [venueId, input.ticketId],
  );
  if (!r.rows[0]) return null;
  if (bumped.rowCount === 1)
    await emitEvent(c, {
      venueId,
      type: "kitchen.ticket_done",
      entityId: input.ticketId,
      audience: "staff",
    });
  return shape(r.rows[0]);
}
