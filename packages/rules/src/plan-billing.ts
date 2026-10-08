import { Temporal } from "@west4/shared";
import { businessDate, wallClock } from "./time.js";

/**
 * Our plan billing (M8-15; spec 03 · Plan billing). A failed plan payment
 * shows a banner in Admin, then makes Admin read-only after 14 days, while
 * the board, rooms, bar and payments never switch off during opening hours.
 *
 * Cautious default (the spec doesn't say when on the 14th day): Admin turns
 * read-only at the first business-date cutover (6:00 AM at West 4) that
 * falls 14 calendar days or more after the failure, in the venue's time
 * zone, so nothing changes in the middle of a night.
 */
export const PLAN_GRACE_DAYS = 14;

export type PlanState = "none" | "ok" | "payment_failed" | "read_only";

export function adminReadOnlyFrom(
  paymentFailedAt: Temporal.Instant | string,
  timeZone: string,
  cutover: string,
): Temporal.Instant {
  const failed =
    typeof paymentFailedAt === "string" ? Temporal.Instant.from(paymentFailedAt) : paymentFailedAt;
  const due = failed.toZonedDateTimeISO(timeZone).add({ days: PLAN_GRACE_DAYS }).toInstant();
  const { businessDate: day } = businessDate(due, timeZone, cutover);
  const start = wallClock(day, cutover, timeZone, cutover);
  return Temporal.Instant.compare(start, due) === 0
    ? start
    : wallClock(day.add({ days: 1 }), cutover, timeZone, cutover);
}

/** The venue's plan state now: no plan, paid, failed (banner), or failed long enough that Admin is read-only. */
export function planState(
  subscription: { readonly payment_failed_at: string | null } | null,
  now: Temporal.Instant,
  timeZone: string,
  cutover: string,
): { state: PlanState; readOnlyFrom: Temporal.Instant | null } {
  if (!subscription) return { state: "none", readOnlyFrom: null };
  if (!subscription.payment_failed_at) return { state: "ok", readOnlyFrom: null };
  const from = adminReadOnlyFrom(subscription.payment_failed_at, timeZone, cutover);
  return {
    state: Temporal.Instant.compare(now, from) >= 0 ? "read_only" : "payment_failed",
    readOnlyFrom: from,
  };
}
