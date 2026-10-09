import { randomUUID } from "node:crypto";
import { splitByStation } from "@west4/shared";
import type { Queryable } from "./tenancy.js";

/**
 * Room orders (M3-06): reads and the guarded status writes. A step updates
 * the row only while it still has the status the step started from, so two
 * bartenders tapping Accept at once can't both sell it. Every function runs
 * inside a venue transaction.
 */
export interface OrderItemRow {
  readonly id: string;
  readonly variant_id: string | null;
  readonly item_id: string | null;
  readonly options: readonly { group: string; name: string; price_delta_cents: number }[];
  readonly qty: number;
  readonly unit_cents: number;
  readonly name_snapshot: string;
  readonly alcohol: boolean;
  readonly tax_category: string;
  readonly station: string;
  readonly notes: string | null;
}

export interface OrderRow {
  readonly id: string;
  readonly check_id: string;
  readonly session_id: string | null;
  readonly room_id: string | null;
  readonly room_name: string | null;
  readonly room_guest_id: string | null;
  readonly source: string;
  readonly status: string;
  readonly cancel_reason: string | null;
  readonly client_order_id: string | null;
  readonly placed_by: string | null;
  readonly placed_at: string;
  readonly business_date: string;
  readonly same_again_of: string | null;
  /** A gift order (M6-24): the singer it's for, their tab, and the singer's name for the ticket. */
  readonly gift_for_singer_id: string | null;
  readonly gift_for_check_id: string | null;
  readonly gift_for_name: string | null;
  readonly held_by: string | null;
  readonly held_at: string | null;
  readonly accepted_by: string | null;
  readonly accepted_by_name: string | null;
  readonly accepted_at: string | null;
  readonly escalated_at: string | null;
  readonly ready_by: string | null;
  readonly ready_at: string | null;
  readonly claimed_by: string | null;
  readonly claimed_by_name: string | null;
  readonly claimed_at: string | null;
  readonly delivered_by: string | null;
  readonly delivered_by_name: string | null;
  readonly delivered_at: string | null;
  readonly returned_by: string | null;
  readonly returned_at: string | null;
  readonly returned_reason: string | null;
  readonly returned_note: string | null;
  readonly return_resolution: string | null;
  readonly cancelled_by: string | null;
  readonly cancelled_at: string | null;
  readonly decline_reason: string | null;
  /** The one station the order belongs to, and the basket it was placed in with the other station's (K-02). */
  readonly station: string;
  readonly basket_id: string | null;
  readonly version: number;
  /** The party's name and size, and IDs checked in the session (the bar's ID line). */
  readonly guest_name: string | null;
  readonly party_size: number | null;
  readonly ids_checked: number;
  readonly returned_by_name: string | null;
  readonly cancelled_by_name: string | null;
  /** The order's latest ticket: its job and whether it printed. */
  readonly ticket_job_id: string | null;
  readonly ticket_status: string | null;
  /** The approver a pending void of this returned order waits for (M3-25). */
  readonly approval_waiting_for: string | null;
  /** A bar tab's name, for an order on a tab (no room). */
  readonly tab_name: string | null;
  /** A replayed offline order (M8-05): who queued it at the bar computer. */
  readonly queued_by: string | null;
  readonly amount_cents: number;
  readonly items: OrderItemRow[];
}

const ts = (col: string) => `to_json(o.${col}) #>> '{}' as ${col}`;
const ORDER_COLS = [
  "o.id",
  "o.check_id",
  "o.session_id",
  "s.room_id",
  "r.name as room_name",
  "o.room_guest_id",
  "o.source",
  "o.status",
  "o.cancel_reason",
  "o.client_order_id",
  "o.placed_by",
  ts("placed_at"),
  "o.business_date::text as business_date",
  "o.same_again_of",
  "o.gift_for_singer_id",
  "o.gift_for_check_id",
  "(select g.display_name from singers g where g.venue_id = o.venue_id and g.id = o.gift_for_singer_id) as gift_for_name",
  "o.held_by",
  ts("held_at"),
  "o.accepted_by",
  "ua.name as accepted_by_name",
  ts("accepted_at"),
  ts("escalated_at"),
  "o.ready_by",
  ts("ready_at"),
  "o.claimed_by",
  "uc.name as claimed_by_name",
  ts("claimed_at"),
  "o.delivered_by",
  "ud.name as delivered_by_name",
  ts("delivered_at"),
  "o.returned_by",
  ts("returned_at"),
  "o.returned_reason",
  "o.returned_note",
  "o.return_resolution",
  "o.cancelled_by",
  ts("cancelled_at"),
  "o.decline_reason",
  "o.station",
  "o.basket_id",
  "o.version",
  "gg.name as guest_name",
  "s.party_size",
  "(select count(*)::int from id_checks i where i.venue_id = o.venue_id and i.session_id = o.session_id) as ids_checked",
  "ur.name as returned_by_name",
  "ux.name as cancelled_by_name",
  "(select j.id from print_jobs j where j.venue_id = o.venue_id and j.order_id = o.id order by j.created_at desc, j.reprint_n desc limit 1) as ticket_job_id",
  "(select j.status from print_jobs j where j.venue_id = o.venue_id and j.order_id = o.id order by j.created_at desc, j.reprint_n desc limit 1) as ticket_status",
  "(select u.name from approvals a join users u on u.id = a.routed_to where a.venue_id = o.venue_id and a.target_kind = 'order' and a.target_id = o.id and a.status = 'pending' limit 1) as approval_waiting_for",
  "(select t.name from tabs t where t.venue_id = o.venue_id and t.check_id = o.check_id limit 1) as tab_name",
  "(select x.staff_name from offline_replays x where x.venue_id = o.venue_id and x.order_id = o.id) as queued_by",
].join(", ");

const FROM = `orders o
  left join room_sessions s on s.venue_id = o.venue_id and s.id = o.session_id
  left join rooms r on r.venue_id = s.venue_id and r.id = s.room_id
  left join users ua on ua.id = o.accepted_by
  left join users uc on uc.id = o.claimed_by
  left join users ud on ud.id = o.delivered_by
  left join users ur on ur.id = o.returned_by
  left join users ux on ux.id = o.cancelled_by
  left join guests gg on gg.venue_id = s.venue_id and gg.id = s.guest_id`;

async function withItems(
  c: Queryable,
  venueId: string,
  rows: Omit<OrderRow, "items" | "amount_cents">[],
): Promise<OrderRow[]> {
  if (rows.length === 0) return [];
  const items = await c.query<OrderItemRow & { order_id: string }>(
    `select id, order_id, variant_id, item_id, options, qty, unit_cents, name_snapshot, alcohol, tax_category, station, notes
       from order_items where venue_id = $1 and order_id = any($2::uuid[]) order by sort, id`,
    [venueId, rows.map((r) => r.id)],
  );
  return rows.map((row) => {
    const mine = items.rows.filter((i) => i.order_id === row.id).map(({ order_id: _, ...i }) => i);
    return {
      ...row,
      items: mine,
      amount_cents: mine.reduce(
        (sum, i) =>
          sum + i.qty * (i.unit_cents + i.options.reduce((s, o) => s + o.price_delta_cents, 0)),
        0,
      ),
    };
  });
}

export async function orderById(
  c: Queryable,
  venueId: string,
  id: string,
): Promise<OrderRow | null> {
  const r = await c.query<Omit<OrderRow, "items" | "amount_cents">>(
    `select ${ORDER_COLS} from ${FROM} where o.venue_id = $1 and o.id = $2`,
    [venueId, id],
  );
  return (await withItems(c, venueId, r.rows))[0] ?? null;
}

/** Orders in some statuses, oldest first: `ringing,held` is the bar's Waiting list, `ready,on_the_way` the Runs. */
export async function listOrders(
  c: Queryable,
  venueId: string,
  statuses: readonly string[],
  options: {
    sessionId?: string | undefined;
    businessDate?: string | undefined;
    limit?: number;
    /** Practice orders ring only screens in training, and live ones only live screens (M7-03). */
    training?: boolean;
  } = {},
): Promise<OrderRow[]> {
  const r = await c.query<Omit<OrderRow, "items" | "amount_cents">>(
    `select ${ORDER_COLS} from ${FROM}
      where o.venue_id = $1 and o.status = any($2::text[]) and ($3::uuid is null or o.session_id = $3)
        and ($5::date is null or o.business_date = $5::date)
        and (select k.training from checks k where k.venue_id = o.venue_id and k.id = o.check_id) = $6
      order by o.placed_at, o.id limit $4`,
    [
      venueId,
      statuses,
      options.sessionId ?? null,
      options.limit ?? 200,
      options.businessDate ?? null,
      options.training ?? false,
    ],
  );
  return withItems(c, venueId, r.rows);
}

export interface NewOrder {
  readonly id?: string;
  readonly checkId: string;
  readonly sessionId: string | null;
  readonly roomGuestId?: string | null;
  readonly source: "room" | "staff" | "gift" | "offline";
  readonly placedBy?: string | null;
  readonly placedAt: string;
  readonly businessDate: string;
  readonly clientOrderId?: string | null;
  readonly sameAgainOf?: string | null;
  readonly giftForSingerId?: string | null;
  readonly giftForCheckId?: string | null;
  /** The basket a split order shares with the other station's (K-02). */
  readonly basketId?: string | null;
  readonly items: readonly {
    readonly id?: string;
    readonly variantId: string | null;
    readonly itemId: string | null;
    readonly options: readonly { group: string; name: string; price_delta_cents: number }[];
    readonly qty: number;
    readonly unitCents: number;
    readonly name: string;
    readonly alcohol: boolean;
    readonly taxCategory: string;
    readonly station: string;
    readonly notes?: string | null;
  }[];
}

/** A new ringing order with its items, prices copied as ordered. */
export async function insertOrder(c: Queryable, venueId: string, o: NewOrder): Promise<string> {
  const r = await c.query<{ id: string }>(
    `insert into orders (id, venue_id, check_id, session_id, room_guest_id, source, placed_by, placed_at,
       business_date, client_order_id, same_again_of, gift_for_singer_id, gift_for_check_id, station, basket_id)
     values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     returning id`,
    [
      o.id ?? null,
      venueId,
      o.checkId,
      o.sessionId,
      o.roomGuestId ?? null,
      o.source,
      o.placedBy ?? null,
      o.placedAt,
      o.businessDate,
      o.clientOrderId ?? null,
      o.sameAgainOf ?? null,
      o.giftForSingerId ?? null,
      o.giftForCheckId ?? null,
      orderStation(o.items),
      o.basketId ?? null,
    ],
  );
  const orderId = r.rows[0]!.id;
  for (const [n, item] of o.items.entries()) {
    await c.query(
      `insert into order_items (id, venue_id, order_id, variant_id, item_id, options, qty, unit_cents,
         name_snapshot, alcohol, tax_category, station, notes, sort)
       values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        item.id ?? null,
        venueId,
        orderId,
        item.variantId,
        item.itemId,
        JSON.stringify(item.options),
        item.qty,
        item.unitCents,
        item.name,
        item.alcohol,
        item.taxCategory,
        item.station,
        item.notes ?? null,
        n,
      ],
    );
  }
  return orderId;
}

/** An order's station: its lines' one station (bar for an order with no lines). */
function orderStation(items: NewOrder["items"]): string {
  const stations = [...new Set(items.map((i) => i.station))];
  if (stations.length > 1) throw new Error(`one order, one station: got ${stations.join(", ")}`);
  return stations[0] ?? "bar";
}

/**
 * A basket or a round (K-02; Kitchen and food · Stations): one order per station, placed together
 * with one basket_id, bar first. The client_order_id goes on the first, so a retry finds the
 * basket through it. Answers the order ids in that order.
 */
export async function insertBasket(c: Queryable, venueId: string, o: NewOrder): Promise<string[]> {
  const parts = splitByStation(o.items);
  if (parts.length <= 1) return [await insertOrder(c, venueId, { ...o, basketId: randomUUID() })];
  const basketId = randomUUID();
  const ids: string[] = [];
  const { id, ...rest } = o;
  for (const [n, part] of parts.entries())
    ids.push(
      await insertOrder(c, venueId, {
        ...rest,
        ...(n === 0 && id !== undefined ? { id } : {}),
        clientOrderId: n === 0 ? (o.clientOrderId ?? null) : null,
        basketId,
        items: part.lines,
      }),
    );
  return ids;
}

/** The orders placed with this one (itself included), bar first. */
export async function basketOrders(
  c: Queryable,
  venueId: string,
  order: OrderRow,
): Promise<OrderRow[]> {
  if (!order.basket_id) return [order];
  const r = await c.query<Omit<OrderRow, "items" | "amount_cents">>(
    `select ${ORDER_COLS} from ${FROM} where o.venue_id = $1 and o.basket_id = $2
      order by case o.station when 'bar' then 0 else 1 end, o.id`,
    [venueId, order.basket_id],
  );
  return withItems(c, venueId, r.rows);
}

/** Writes a step's columns while the order still has `from`'s status; false when it moved first. */
export async function moveOrder(
  c: Queryable,
  venueId: string,
  id: string,
  from: readonly string[],
  set: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  const cols = Object.keys(set);
  const r = await c.query(
    `update orders set ${cols.map((col, i) => `${col} = $${i + 4}`).join(", ")}, version = version + 1
      where venue_id = $1 and id = $2 and status = any($3::text[])`,
    [venueId, id, from, ...cols.map((col) => set[col])],
  );
  return r.rowCount === 1;
}

export async function insertPrintJob(
  c: Queryable,
  venueId: string,
  job: {
    orderId?: string | null;
    checkId?: string | null;
    kind: "ticket" | "receipt" | "check" | "drawer" | "x_report" | "z_report" | "break_glass";
    station: string;
    payload: unknown;
    deviceId?: string | null;
    reprintOf?: string | null;
    reprintN?: number;
    createdAt: string;
  },
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `insert into print_jobs (venue_id, device_id, order_id, check_id, kind, station, payload, reprint_of, reprint_n, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
    [
      venueId,
      job.deviceId ?? null,
      job.orderId ?? null,
      job.checkId ?? null,
      job.kind,
      job.station,
      JSON.stringify(job.payload),
      job.reprintOf ?? null,
      job.reprintN ?? 0,
      job.createdAt,
    ],
  );
  return r.rows[0]!.id;
}
