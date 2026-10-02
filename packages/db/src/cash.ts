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
     values ($1, $2, $3, $4, 'open', $5, $6, $7) returning id`,
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
    `insert into staff_banks (venue_id, user_id, business_date) values ($1, $2, $3)
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
