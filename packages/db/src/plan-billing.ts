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
  // A subscription that has ended (cancelled, or never paid) is replaced by
  // the new one; a live one is never overwritten.
  const r = await c.query(
    `insert into venue_subscriptions (venue_id, plan, stripe_subscription_id, room_item_id, room_quantity, status)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (venue_id) do update
        set plan = excluded.plan, stripe_subscription_id = excluded.stripe_subscription_id,
            room_item_id = excluded.room_item_id, room_quantity = excluded.room_quantity,
            status = excluded.status, payment_failed_at = null, failed_invoice_id = null,
            updated_at = now()
      where venue_subscriptions.status = any($7::text[])`,
    [
      row.venueId,
      row.plan,
      row.subscriptionId,
      row.roomItemId,
      row.roomQuantity,
      row.status,
      ENDED_PLAN_STATUSES,
    ],
  );
  if (r.rowCount !== 1) throw new Error(`venue ${row.venueId} already has a live plan`);
}

/** Stripe statuses after which a venue's subscription is over and it may subscribe again. */
export const ENDED_PLAN_STATUSES: readonly string[] = ["canceled", "incomplete_expired"];

/**
 * The attempt whose id keys the Stripe call that makes a venue's
 * subscription (migration 0134). Made before the call, in its own
 * transaction: an unfinished attempt for the same plan and room count is
 * the same attempt retried, so it's reused and Stripe replays its answer;
 * anything else is a new attempt with a new key.
 */
export async function planSubscribeAttempt(
  c: Queryable,
  input: { venueId: string; plan: PlanId; rooms: number },
): Promise<string> {
  // Two clicks at once find the same attempt, so Stripe makes one subscription.
  await c.query("select pg_advisory_xact_lock(hashtext('plan_subscribe:' || $1))", [input.venueId]);
  const open = await c.query<{ id: string }>(
    `select id from plan_subscribe_attempts
      where venue_id = $1 and plan = $2 and rooms = $3 and finished_at is null
      order by created_at desc limit 1`,
    [input.venueId, input.plan, input.rooms],
  );
  if (open.rows[0]) return open.rows[0].id;
  const made = await c.query<{ id: string }>(
    `insert into plan_subscribe_attempts (venue_id, plan, rooms) values ($1, $2, $3) returning id`,
    [input.venueId, input.plan, input.rooms],
  );
  return made.rows[0]!.id;
}

/** The attempt is done: its subscription is recorded, so its key is never used again. */
export async function finishPlanSubscribeAttempt(
  c: Queryable,
  attemptId: string,
  subscriptionId: string,
): Promise<void> {
  await c.query(
    `update plan_subscribe_attempts set stripe_subscription_id = $2, finished_at = now()
      where id = $1`,
    [attemptId, subscriptionId],
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
