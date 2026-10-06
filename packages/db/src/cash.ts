import type { Queryable } from "./tenancy.js";

/**
 * Cash drawers, their sessions and moves, and staff banks (M4-13; Money
 * rules 15). Inside a venue transaction.
 */
export interface DrawerRow {
  readonly id: string;
  readonly name: string;
  readonly station: string | null;
  readonly printer_device_id: string | null;
  readonly printer_name: string | null;
  readonly session_id: string | null;
  readonly opening_cents: number | null;
}

export async function venueDrawers(c: Queryable, venueId: string): Promise<DrawerRow[]> {
  const r = await c.query<DrawerRow>(
    `select d.id, d.name, d.station, d.printer_device_id, p.name as printer_name,
            s.id as session_id, s.opening_cents::int as opening_cents
       from cash_drawers d
       left join devices p on p.venue_id = d.venue_id and p.id = d.printer_device_id
       left join drawer_sessions s on s.venue_id = d.venue_id and s.drawer_id = d.id and s.state = 'open'
      where d.venue_id = $1 order by d.name`,
    [venueId],
  );
  return r.rows;
}

/** The drawer a screen is paired to, with its open session (null: no drawer, or none open). */
export async function drawerOfDevice(
  c: Queryable,
  venueId: string,
  deviceId: string,
): Promise<DrawerRow | null> {
  const r = await c.query<DrawerRow>(
    `select d.id, d.name, d.station, d.printer_device_id, p.name as printer_name,
            s.id as session_id, s.opening_cents::int as opening_cents
       from devices v join cash_drawers d on d.venue_id = v.venue_id and d.id = v.cash_drawer_id
       left join devices p on p.venue_id = d.venue_id and p.id = d.printer_device_id
       left join drawer_sessions s on s.venue_id = d.venue_id and s.drawer_id = d.id and s.state = 'open'
      where v.venue_id = $1 and v.id = $2`,
    [venueId, deviceId],
  );
  return r.rows[0] ?? null;
}

/** Opens a drawer's session with the starting bank, unless one is open. Returns the open session's id. */
export async function openDrawerSession(
  c: Queryable,
  venueId: string,
  input: {
    drawerId: string;
    model: "house" | "per_person";
    responsibleId: string | null;
    businessDate: string;
    openingCents: number;
    at: string;
  },
): Promise<{ id: string; opened: boolean }> {
  const open = await c.query<{ id: string }>(
    "select id from drawer_sessions where venue_id = $1 and drawer_id = $2 and state = 'open'",
    [venueId, input.drawerId],
  );
  if (open.rows[0]) return { id: open.rows[0].id, opened: false };
  const r = await c.query<{ id: string }>(
    `insert into drawer_sessions (venue_id, drawer_id, model, responsible_id, state, business_date, opened_at, opening_cents)
     values ($1, $2, $3, $4, 'open', open_business_date($1, $5::date), $6, $7) returning id`,
    [
      venueId,
      input.drawerId,
      input.model,
      input.responsibleId,
      input.businessDate,
      input.at,
      input.openingCents,
    ],
  );
  return { id: r.rows[0]!.id, opened: true };
}

/** A person's staff bank for the business date, made if it isn't there yet. */
export async function staffBank(
  c: Queryable,
  venueId: string,
  userId: string,
  businessDate: string,
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `insert into staff_banks (venue_id, user_id, business_date) values ($1, $2, open_business_date($1, $3::date))
     on conflict (venue_id, user_id, business_date) do update set cash_cents = staff_banks.cash_cents
     returning id`,
    [venueId, userId, businessDate],
  );
  return r.rows[0]!.id;
}

export async function addToStaffBank(
  c: Queryable,
  venueId: string,
  bankId: string,
  cents: number,
): Promise<void> {
  await c.query(
    "update staff_banks set cash_cents = cash_cents + $3 where venue_id = $1 and id = $2",
    [venueId, bankId, cents],
  );
}

export async function insertDrawerMove(
  c: Queryable,
  venueId: string,
  m: {
    drawerSessionId?: string | null;
    staffBankId?: string | null;
    kind: "sale" | "refund" | "paid_out" | "drop" | "no_sale" | "tip_out";
    amountCents: number;
    paymentId?: string | null;
    takenBy: string;
    deviceId?: string | null;
    reason?: string | null;
    at: string;
  },
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `insert into drawer_moves (venue_id, drawer_session_id, staff_bank_id, kind, amount_cents, payment_id, taken_by,
       device_id, reason, at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
    [
      venueId,
      m.drawerSessionId ?? null,
      m.staffBankId ?? null,
      m.kind,
      m.amountCents,
      m.paymentId ?? null,
      m.takenBy,
      m.deviceId ?? null,
      m.reason ?? null,
      m.at,
    ],
  );
  return r.rows[0]!.id;
}

/** What a drawer session should hold: its starting bank and its moves (sales in, refunds and paid-outs out). */
export async function expectedInDrawer(
  c: Queryable,
  venueId: string,
  sessionId: string,
): Promise<number> {
  const r = await c.query<{ cents: string }>(
    `select (s.opening_cents + coalesce(sum(case when m.kind in ('sale', 'drop') then m.amount_cents
                                                 when m.kind in ('refund', 'paid_out', 'tip_out') then -m.amount_cents
                                                 else 0 end), 0))::text as cents
       from drawer_sessions s left join drawer_moves m on m.venue_id = s.venue_id and m.drawer_session_id = s.id
      where s.venue_id = $1 and s.id = $2 group by s.opening_cents`,
    [venueId, sessionId],
  );
  return Number(r.rows[0]?.cents ?? 0);
}

/** A drawer session with its drawer, for a count or a handover (M7-05). */
export interface DrawerSessionRow {
  readonly id: string;
  readonly drawer_id: string;
  readonly drawer_name: string;
  readonly station: "bar" | "front_desk" | null;
  readonly model: "house" | "per_person";
  readonly state: "open" | "pulled" | "counted" | "closed";
  readonly business_date: string;
  readonly opening_cents: number;
  readonly responsible_id: string | null;
  readonly owner_id: string | null;
}

const SESSION_COLS = `s.id, s.drawer_id, d.name as drawer_name, d.station, s.model, s.state, s.business_date::text,
  s.opening_cents::int as opening_cents, s.responsible_id, s.owner_id`;

export async function drawerSessionById(
  c: Queryable,
  venueId: string,
  sessionId: string,
  forUpdate = false,
): Promise<DrawerSessionRow | null> {
  const r = await c.query<DrawerSessionRow>(
    `select ${SESSION_COLS} from drawer_sessions s join cash_drawers d on d.venue_id = s.venue_id and d.id = s.drawer_id
      where s.venue_id = $1 and s.id = $2${forUpdate ? " for update of s" : ""}`,
    [venueId, sessionId],
  );
  return r.rows[0] ?? null;
}

/** A session's moves, for what it should hold. */
export async function drawerSessionMoves(
  c: Queryable,
  venueId: string,
  sessionId: string,
): Promise<
  { kind: "sale" | "refund" | "paid_out" | "drop" | "no_sale" | "tip_out"; amountCents: number }[]
> {
  const r = await c.query<{
    kind: "sale" | "refund" | "paid_out" | "drop" | "no_sale" | "tip_out";
    cents: string;
  }>(
    "select kind, amount_cents::text as cents from drawer_moves where venue_id = $1 and drawer_session_id = $2",
    [venueId, sessionId],
  );
  return r.rows.map((m) => ({ kind: m.kind, amountCents: Number(m.cents) }));
}

/** Records a blind count on an open (or pulled) session: `counted`, or `closed` when a handover closes it. */
export async function recordDrawerCount(
  c: Queryable,
  venueId: string,
  sessionId: string,
  input: {
    countedCents: number;
    expectedCents: number;
    overShortCents: number;
    note: string | null;
    countedBy: string;
    witnessId: string | null;
    at: string;
    close: boolean;
  },
): Promise<void> {
  await c.query(
    `update drawer_sessions set state = $3, counted_at = $4, counted_by = $5, witness_id = $6, counted_cents = $7,
            expected_cents = $8, over_short_cents = $9, note = $10, closed_at = case when $3 = 'closed' then $4::timestamptz end
      where venue_id = $1 and id = $2`,
    [
      venueId,
      sessionId,
      input.close ? "closed" : "counted",
      input.at,
      input.countedBy,
      input.witnessId,
      input.countedCents,
      input.expectedCents,
      input.overShortCents,
      input.note,
    ],
  );
}

/** Every session of a business date, each drawer's newest first: what Night's drawer panel shows. */
export interface DrawerPanelRow extends DrawerSessionRow {
  readonly opened_at: string;
  readonly counted_cents: number | null;
  readonly expected_cents: number | null;
  readonly over_short_cents: number | null;
  readonly note: string | null;
  readonly counted_at: string | null;
  readonly counted_by_name: string | null;
  readonly witness_name: string | null;
  readonly responsible_name: string | null;
  readonly approved_by: string | null;
  readonly handover_id: string | null;
}

export async function drawerSessionsOfDate(
  c: Queryable,
  venueId: string,
  businessDate: string,
): Promise<DrawerPanelRow[]> {
  const r = await c.query<DrawerPanelRow>(
    `select ${SESSION_COLS}, to_json(s.opened_at) #>> '{}' as opened_at, s.counted_cents::int as counted_cents,
            s.expected_cents::int as expected_cents, s.over_short_cents::int as over_short_cents, s.note,
            to_json(s.counted_at) #>> '{}' as counted_at, cb.name as counted_by_name, w.name as witness_name,
            r.name as responsible_name, s.approved_by, s.handover_id
       from drawer_sessions s join cash_drawers d on d.venue_id = s.venue_id and d.id = s.drawer_id
       left join users cb on cb.id = s.counted_by
       left join users w on w.id = s.witness_id
       left join users r on r.id = s.responsible_id
      where s.venue_id = $1 and s.business_date = $2::date
      order by d.name, s.opened_at desc, s.id`,
    [venueId, businessDate],
  );
  return r.rows;
}

/** The handover waiting for its incoming manager, if any. */
export interface DrawerHandoverRow {
  readonly id: string;
  readonly from_user_id: string;
  readonly to_user_id: string;
  readonly to_name: string;
  readonly approval_id: string | null;
  readonly state: "pending" | "accepted" | "declined";
}

export async function pendingDrawerHandover(
  c: Queryable,
  venueId: string,
): Promise<DrawerHandoverRow | null> {
  const r = await c.query<DrawerHandoverRow>(
    `select h.id, h.from_user_id, h.to_user_id, u.name as to_name, h.approval_id, h.state
       from drawer_handovers h join users u on u.id = h.to_user_id
      where h.venue_id = $1 and h.state = 'pending'`,
    [venueId],
  );
  return r.rows[0] ?? null;
}
