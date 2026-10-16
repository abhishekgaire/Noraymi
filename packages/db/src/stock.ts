import type pg from "pg";
import { Temporal } from "@west4/shared";
import { emitEvent } from "./events.js";
import { enqueue } from "./jobs/queue.js";
import { moduleOn } from "./modules.js";
import { readSetting } from "./settings.js";
import type { Queryable } from "./tenancy.js";

/**
 * Inventory (P-16; spec 04 · Inventory; module `inventory`). A stock count per menu item, or per
 * variant when the venue counts its sizes apart (a variant's own level wins for that variant).
 * `addCheckLine` calls `stockForLine` for every line it writes, so every path that sells (Accept,
 * the bar POS, a quick sale, a replayed offline round) takes the count down once, and a void that
 * wasn't made puts it back (a made void is waste: the drink was poured, the count stays down).
 * Receive, Count and Adjust (with a reason) come from Reports → Stock. Every change is a
 * `stock_moves` row; nothing moves while the module is off or on a practice (training) check.
 *
 * At zero, while `inventory.autoEightySix` is on (the default), a sale that takes the count to
 * zero 86's the item (or the variant counted) to the end of the business date, the same 86 staff
 * set by hand; the count coming back above zero brings it back, and a night closed with it still
 * at zero keeps it out for the next night (`holdStockOuts`). Crossing the level set as low pushes
 * the managers and owners once per crossing.
 */
export type StockMoveKind = "sale" | "void" | "receive" | "count" | "adjust";

export interface StockLevelRow {
  readonly id: string;
  readonly item_id: string;
  readonly variant_id: string | null;
  readonly on_hand: number;
  readonly low_at: number | null;
  readonly auto_out: boolean;
}

/** The level an order item counts against: its variant's own, else its item's. */
async function levelForOrderItem(
  c: Queryable,
  venueId: string,
  orderItemId: string,
): Promise<string | null> {
  const r = await c.query<{ id: string }>(
    `select s.id from order_items oi
       left join menu_variants v on v.venue_id = oi.venue_id and v.id = oi.variant_id
       join stock_levels s on s.venue_id = oi.venue_id and s.active
        and (s.variant_id = oi.variant_id
             or (s.variant_id is null and s.item_id = coalesce(oi.item_id, v.item_id)))
      where oi.venue_id = $1 and oi.id = $2
      order by s.variant_id is null limit 1`,
    [venueId, orderItemId],
  );
  return r.rows[0]?.id ?? null;
}

/** The order item a reversed line was sold from, following a line moved between checks. */
async function soldFrom(c: Queryable, venueId: string, lineId: number): Promise<string | null> {
  let id: number | null = lineId;
  for (let hops = 0; id !== null && hops < 8; hops++) {
    type Line = {
      kind: string;
      source_id: string | null;
      check_id: string;
      moved_check_id: string | null;
    };
    const r: pg.QueryResult<Line> = await c.query<Line>(
      "select kind, source_id, check_id, moved_check_id from check_lines where venue_id = $1 and id = $2",
      [venueId, id],
    );
    const line: Line | undefined = r.rows[0];
    if (!line) return null;
    if (line.kind === "item") return line.source_id;
    if (line.kind !== "transfer_in" || !line.moved_check_id) return null;
    // A moved line: its transfer_out on the other check, written just before it, reverses the sold one.
    const out: pg.QueryResult<{ reverses_id: string | null }> = await c.query<{
      reverses_id: string | null;
    }>(
      `select reverses_id from check_lines
        where venue_id = $1 and check_id = $2 and kind = 'transfer_out' and moved_check_id = $3 and id < $4
        order by id desc limit 1`,
      [venueId, line.moved_check_id, line.check_id, id],
    );
    id = out.rows[0]?.reverses_id ? Number(out.rows[0].reverses_id) : null;
  }
  return null;
}

/** After a line is written: a sale takes its count down, a void not made puts it back. */
export async function stockForLine(
  c: Queryable,
  venueId: string,
  checkId: string,
  line: {
    readonly id: number;
    readonly kind: string;
    readonly qty: number;
    readonly sourceId?: string | null;
    readonly reversesId?: number | null;
    readonly made?: boolean | null;
    readonly businessDate: string;
    readonly addedBy?: string | null;
    readonly at: string;
  },
): Promise<void> {
  const sale = line.kind === "item" && !!line.sourceId;
  const back = line.kind === "void" && line.reversesId != null && line.made !== true;
  if (!sale && !back) return;
  // Most venues count nothing: one cheap look before anything else.
  const any = await c.query("select 1 from stock_levels where venue_id = $1 and active limit 1", [
    venueId,
  ]);
  if (!any.rowCount) return;
  if (!(await moduleOn(c, venueId, "inventory"))) return;
  const training = await c.query<{ training: boolean }>(
    "select training from checks where venue_id = $1 and id = $2",
    [venueId, checkId],
  );
  if (training.rows[0]?.training) return;
  const orderItem = sale ? line.sourceId! : await soldFrom(c, venueId, line.reversesId!);
  if (!orderItem) return;
  const level = await levelForOrderItem(c, venueId, orderItem);
  if (!level) return;
  const qty = Math.abs(Math.trunc(line.qty));
  if (qty === 0) return;
  await moveStock(c, venueId, level, {
    kind: sale ? "sale" : "void",
    delta: sale ? -qty : qty,
    lineId: line.id,
    businessDate: line.businessDate,
    by: line.addedBy ?? null,
    at: line.at,
  });
}

/** The end of a business date: its next day's cutover, in the venue's time zone. */
async function endOf(c: Queryable, venueId: string, businessDate: string): Promise<string> {
  const r = await c.query<{ until: Date }>(
    `select ((($2::date + 1)::timestamp + day_cutover) at time zone time_zone) as until
       from venues where id = $1`,
    [venueId, businessDate],
  );
  return r.rows[0]!.until.toISOString();
}

async function autoEightySix(c: Queryable, venueId: string, businessDate: string) {
  const s = await readSetting(c, venueId, "inventory", Temporal.PlainDate.from(businessDate));
  return s?.value.autoEightySix ?? true;
}

async function setOut(c: Queryable, venueId: string, level: StockLevelRow, until: string | null) {
  if (level.variant_id)
    await c.query(
      "update menu_variants set out_until = $3, updated_at = now() where venue_id = $1 and id = $2",
      [venueId, level.variant_id, until],
    );
  else
    await c.query(
      "update menu_items set out_until = $3, updated_at = now() where venue_id = $1 and id = $2",
      [venueId, level.item_id, until],
    );
  await c.query(
    "update stock_levels set auto_out = $3, updated_at = now() where venue_id = $1 and id = $2",
    [venueId, level.id, until !== null],
  );
  await emitEvent(c, { venueId, type: "menu.changed", entityId: level.item_id });
}

/**
 * Moves one level by `delta` (a Count passes the difference) and writes its ledger row; then the
 * 86 at zero, the 86 lifted above zero, and the low-stock push. Returns the level after the move.
 */
export async function moveStock(
  c: Queryable,
  venueId: string,
  levelId: string,
  m: {
    readonly kind: StockMoveKind;
    readonly delta: number;
    readonly reason?: string | null;
    readonly lineId?: number | null;
    /** The line's business date; a hand move takes the open night's from `at`. */
    readonly businessDate?: string | null;
    readonly by: string | null;
    readonly at: string;
  },
): Promise<StockLevelRow> {
  const r = await c.query<StockLevelRow & { on_hand: number }>(
    `update stock_levels set on_hand = on_hand + $3, updated_at = now()
      where venue_id = $1 and id = $2
      returning id, item_id, variant_id, on_hand, low_at, auto_out`,
    [venueId, levelId, m.delta],
  );
  const level = r.rows[0]!;
  const before = level.on_hand - m.delta;
  const date = await c.query<{ d: string }>(
    `select (case when $2::date is null then posting_business_date($1, $3::timestamptz)
                  else open_business_date($1, $2::date) end)::text as d`,
    [venueId, m.businessDate ?? null, m.at],
  );
  const businessDate = date.rows[0]!.d;
  await c.query(
    `insert into stock_moves (venue_id, stock_id, kind, delta, on_hand_after, reason, line_id, business_date, by_user, at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      venueId,
      levelId,
      m.kind,
      m.delta,
      level.on_hand,
      m.reason ?? null,
      m.lineId ?? null,
      businessDate,
      m.by,
      m.at,
    ],
  );
  let after: StockLevelRow = level;
  if (m.kind === "sale" && before > 0 && level.on_hand <= 0) {
    if (await autoEightySix(c, venueId, businessDate)) {
      await setOut(c, venueId, level, await endOf(c, venueId, businessDate));
      after = { ...level, auto_out: true };
    }
  } else if (level.auto_out && level.on_hand > 0) {
    await setOut(c, venueId, level, null);
    after = { ...level, auto_out: false };
  }
  if (
    level.low_at !== null &&
    m.delta < 0 &&
    before > level.low_at &&
    level.on_hand <= level.low_at
  )
    await pushLow(c, venueId, level, m.at);
  await emitEvent(c, { venueId, type: "stock.changed", entityId: levelId, audience: "managers" });
  return after;
}

async function pushLow(c: Queryable, venueId: string, level: StockLevelRow, at: string) {
  const name = await c.query<{ name: string }>(
    `select i.name || coalesce(' · ' || v.name, '') as name from menu_items i
       left join menu_variants v on v.venue_id = i.venue_id and v.id = $3
      where i.venue_id = $1 and i.id = $2`,
    [venueId, level.item_id, level.variant_id],
  );
  const seq = await c.query<{ id: string }>(
    "select max(id)::text as id from stock_moves where venue_id = $1 and stock_id = $2",
    [venueId, level.id],
  );
  for (const role of ["manager", "owner"])
    await enqueue(c, {
      venueId,
      kind: "push.send",
      pool: "normal",
      runAt: Temporal.Instant.from(at),
      payload: {
        audience: { kind: "role", role },
        message: {
          key: "push.lowStock",
          params: { item: name.rows[0]?.name ?? "", count: String(level.on_hand) },
          url: "/reports",
          tag: `low-stock-${level.id}`,
        },
      },
      dedupeKey: `low-stock:${seq.rows[0]!.id}:${role}`,
      maxAttempts: 3,
    });
}

/**
 * The night close lifts every 86 (M7); a level still at zero that 86'd its item keeps it out
 * through the next business date, while 86 at zero is on.
 */
export async function holdStockOuts(
  c: Queryable,
  venueId: string,
  closedDate: string,
): Promise<void> {
  const held = await c.query<StockLevelRow>(
    `select id, item_id, variant_id, on_hand, low_at, auto_out from stock_levels
      where venue_id = $1 and active and auto_out and on_hand <= 0`,
    [venueId],
  );
  if (!held.rowCount) return;
  const next = Temporal.PlainDate.from(closedDate).add({ days: 1 }).toString();
  if (!(await moduleOn(c, venueId, "inventory")) || !(await autoEightySix(c, venueId, next))) {
    await c.query("update stock_levels set auto_out = false where venue_id = $1 and auto_out", [
      venueId,
    ]);
    return;
  }
  const until = await endOf(c, venueId, next);
  for (const level of held.rows) await setOut(c, venueId, level, until);
}
