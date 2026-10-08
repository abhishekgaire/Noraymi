import type { Queryable } from "@west4/db";
import { parseTraceparent, type Span } from "@west4/shared";
import { telemetry } from "./index.js";

/**
 * A room order's trace (M8-16): the room page's request span is stored with the order, and the
 * bar device's alarm closes it with a "bar.alarm" span whose length is the time from order to
 * alarm, the target's number (under 3 seconds for 95% of orders). Ids and times only.
 */
export async function noteOrderTrace(
  c: Queryable,
  venueId: string,
  order: { readonly id: string; readonly placed_at: string },
  span: Span | null,
): Promise<void> {
  if (!span) return;
  span.setAttributes({ "order.id": order.id, "order.source": "room" });
  await c.query(
    `insert into order_traces (venue_id, order_id, trace_parent, placed_at)
     values ($1, $2, $3, $4) on conflict do nothing`,
    [venueId, order.id, span.traceparent, order.placed_at],
  );
}

/**
 * A bar device's alarm rang for an order: the first ring closes the trace and records how long it
 * took on the venue's clock (the simulated one on staging). A later ring, or an order that wasn't
 * traced, changes nothing. Answers the milliseconds, or null.
 */
export async function noteAlarm(
  c: Queryable,
  venueId: string,
  orderId: string,
  deviceId: string,
  rangAt: string,
): Promise<number | null> {
  const r = await c.query<{ trace_parent: string; ms: string }>(
    `update order_traces set rang_at = $3, rang_device = $4
      where venue_id = $1 and order_id = $2 and rang_at is null
      returning trace_parent,
                round(extract(epoch from ($3::timestamptz - placed_at)) * 1000)::bigint as ms`,
    [venueId, orderId, rangAt, deviceId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const ms = Math.max(0, Number(row.ms));
  const t = telemetry();
  // The span ends now on the real clock and is as long as the venue's clock says it took.
  const end = Date.now();
  const attrs = { "order.id": orderId, venue: venueId, device: deviceId, slow: ms >= 3000 };
  t.startSpan("bar.alarm", {
    parent: parseTraceparent(row.trace_parent),
    startMs: end - ms,
    attributes: attrs,
  }).end({ endMs: end });
  t.observe("order_to_alarm_ms", ms, { venue: venueId, slow: ms >= 3000 });
  return ms;
}
