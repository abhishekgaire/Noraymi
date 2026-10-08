import type { Queryable } from "./tenancy.js";

/**
 * Our plan billing (M8-15; spec 03 · Plan billing; spec 04 ·
 * venue_subscriptions): one subscription per venue on our own Stripe
 * account. The rows change only from what Stripe says, read again after
 * each billing event, and from the room count the quantity job sends.
 */
export type PlanId = "bar" | "rooms" | "rooms_kitchen";
export const PLAN_IDS: readonly PlanId[] = ["bar", "rooms", "rooms_kitchen"];

export interface VenueSubscriptionRow {
  readonly venue_id: string;
  readonly plan: PlanId;
  readonly stripe_subscription_id: string;
  readonly room_item_id: string | null;
  readonly room_quantity: number;
  readonly status: string;
  readonly payment_failed_at: string | null;
  readonly failed_invoice_id: string | null;
}

const COLUMNS = `venue_id, plan, stripe_subscription_id, room_item_id, room_quantity, status,
  to_json(payment_failed_at) #>> '{}' as payment_failed_at, failed_invoice_id`;

export async function venueSubscription(
  c: Queryable,
  venueId: string,
  options: { lock?: boolean } = {},
): Promise<VenueSubscriptionRow | null> {
  const r = await c.query<VenueSubscriptionRow>(
    `select ${COLUMNS} from venue_subscriptions where venue_id = $1${options.lock ? " for update" : ""}`,
    [venueId],
  );
  return r.rows[0] ?? null;
}

export async function insertVenueSubscription(
  c: Queryable,
  row: {
    venueId: string;
    plan: PlanId;
    subscriptionId: string;
    roomItemId: string | null;
    roomQuantity: number;
    status: string;
  },
): Promise<void> {
  await c.query(
    `insert into venue_subscriptions (venue_id, plan, stripe_subscription_id, room_item_id, room_quantity, status)
     values ($1, $2, $3, $4, $5, $6)`,
    [row.venueId, row.plan, row.subscriptionId, row.roomItemId, row.roomQuantity, row.status],
  );
}

/** Stripe's status, and the failure: set once when a plan payment fails, cleared when it's paid. */
export async function setPlanStatus(
  c: Queryable,
  venueId: string,
  change: {
    status: string;
    failure?: { at: string; invoiceId: string | null } | "cleared";
  },
): Promise<VenueSubscriptionRow | null> {
  const failure = change.failure;
  const r = await c.query<VenueSubscriptionRow>(
    `update venue_subscriptions set status = $2,
        payment_failed_at = case when $3::text = 'cleared' then null
                                 when $3::text = 'failed' then coalesce(payment_failed_at, $4::timestamptz)
                                 else payment_failed_at end,
        failed_invoice_id = case when $3::text = 'cleared' then null
                                 when $3::text = 'failed' then coalesce(failed_invoice_id, $5::text)
                                 else failed_invoice_id end,
        updated_at = now()
      where venue_id = $1 returning ${COLUMNS}`,
    [
      venueId,
      change.status,
      failure === "cleared" ? "cleared" : failure ? "failed" : "same",
      failure && failure !== "cleared" ? failure.at : null,
      failure && failure !== "cleared" ? failure.invoiceId : null,
    ],
  );
  return r.rows[0] ?? null;
}

export async function setRoomQuantity(
  c: Queryable,
  venueId: string,
  quantity: number,
): Promise<void> {
  await c.query(
    "update venue_subscriptions set room_quantity = $2, updated_at = now() where venue_id = $1",
    [venueId, quantity],
  );
}

/** The per-room fee counts every room that isn't archived, switched off tonight or not. */
export async function billableRooms(c: Queryable, venueId: string): Promise<number> {
  const r = await c.query<{ n: number }>(
    "select count(*)::int as n from rooms where venue_id = $1 and archived_at is null",
    [venueId],
  );
  return r.rows[0]!.n;
}

/** The venue's clock settings, for when Admin turns read-only. */
export async function venueClockSettings(
  c: Queryable,
  venueId: string,
): Promise<{ time_zone: string; day_cutover: string }> {
  const r = await c.query<{ time_zone: string; day_cutover: string }>(
    "select time_zone, to_char(day_cutover, 'HH24:MI') as day_cutover from venues where id = $1",
    [venueId],
  );
  return r.rows[0] ?? { time_zone: "America/New_York", day_cutover: "06:00" };
}
