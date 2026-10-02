import type pg from "pg";
import { emitEvent, readSetting, withVenue, type Queryable, type Sweep } from "@west4/db";
import { businessDate } from "@west4/rules";
import { Temporal } from "@west4/shared";
import { managerOnDutyAt } from "../approvals/service.js";
import { enqueueText } from "../jobs/send-text.js";
import { enqueuePush } from "../push/send-push.js";
import { venueClock } from "../rooms/assignment.js";

/**
 * Escalating room orders nobody has accepted (M3-16; spec 10 rule 7 and Room
 * orders at the bar; glossary · the escalation sentence). Ringing and asked-
 * to-wait orders age from when they were placed, on `pos.orderAging`: at 30
 * seconds every bar-role phone buzzes, at 2 minutes the board shows the
 * order, at 4 the manager on duty's phone gets a push, at 6 they're texted.
 * Each step happens once (`orders.escalation_level`) and sends
 * `order.escalated`; Accept, a cancel or a decline takes the order out of
 * the list, which stops the rest. The sweep runs every 5 seconds.
 */
export const ESCALATION_EVERY_MS = 5_000;
const DEFAULT_AGING = { phonesSec: 30, amberSec: 120, pinkSec: 240, callSec: 360 };

export interface Aging {
  readonly phonesSec: number;
  readonly amberSec: number;
  readonly pinkSec: number;
  readonly callSec: number;
}

export async function agingFor(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
): Promise<Aging> {
  const clock = await venueClock(c, venueId);
  const date = businessDate(now, clock.timeZone, clock.dayCutover).businessDate;
  return (await readSetting(c, venueId, "pos", date))?.value.orderAging ?? DEFAULT_AGING;
}

/** The level an order of this age has reached: 0 to 4. */
export function levelAt(ageSec: number, a: Aging): number {
  if (ageSec >= a.callSec) return 4;
  if (ageSec >= a.pinkSec) return 3;
  if (ageSec >= a.amberSec) return 2;
  if (ageSec >= a.phonesSec) return 1;
  return 0;
}

export async function escalateOrders(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
): Promise<number> {
  const aging = await agingFor(c, venueId, now);
  const rows = await c.query<{
    id: string;
    placed_at: Date;
    escalation_level: number;
    room_id: string | null;
    room_name: string | null;
    items: string;
  }>(
    `select o.id, o.placed_at, o.escalation_level, s.room_id, r.name as room_name,
            (select string_agg(i.qty || ' × ' || i.name_snapshot, ', ' order by i.sort)
               from order_items i where i.venue_id = o.venue_id and i.order_id = o.id) as items
       from orders o
       left join room_sessions s on s.venue_id = o.venue_id and s.id = o.session_id
       left join rooms r on r.venue_id = s.venue_id and r.id = s.room_id
      where o.venue_id = $1 and o.status in ('ringing', 'held') and o.escalation_level < 4`,
    [venueId],
  );
  let moved = 0;
  for (const o of rows.rows) {
    const age = Math.floor((now.epochMilliseconds - o.placed_at.getTime()) / 1000);
    const target = levelAt(age, aging);
    if (target <= o.escalation_level) continue;
    const room = o.room_name ?? "";
    for (let level = o.escalation_level + 1; level <= target; level++) {
      if (level === 1)
        for (const role of ["bartender", "front_desk"] as const)
          await enqueuePush(c, {
            venueId,
            audience: { kind: "role", role },
            message: {
              key: "orders.push.ringing",
              params: { room, items: o.items ?? "" },
              url: "/bar-orders",
              tag: `order-${o.id}`,
            },
            runAt: now,
            dedupeKey: `order-ring:${o.id}:${role}`,
          });
      if (level === 3 || level === 4) {
        const manager = await managerOnDutyAt(c, venueId, now);
        if (!manager) continue;
        if (level === 3)
          await enqueuePush(c, {
            venueId,
            audience: { kind: "person", userId: manager },
            message: {
              key: "orders.push.waiting",
              params: { room, minutes: Math.floor(aging.pinkSec / 60), items: o.items ?? "" },
              url: "/bar-orders",
              tag: `order-${o.id}`,
            },
            runAt: now,
            dedupeKey: `order-manager:${o.id}`,
          });
        else {
          const who = await c.query<{
            phone_e164: string | null;
            venue_name: string;
            locale: string | null;
          }>(
            `select u.phone_e164, v.name as venue_name, m.locale
               from users u join memberships m on m.user_id = u.id and m.venue_id = $1
               join venues v on v.id = $1
              where u.id = $2 and u.phone_verified_at is not null`,
            [venueId, manager],
          );
          const m = who.rows[0];
          if (m?.phone_e164)
            await enqueueText(c, {
              venueId,
              runAt: now,
              template: "order_waiting",
              to: m.phone_e164,
              locale: m.locale === "es" ? "es" : "en",
              data: {
                venueName: m.venue_name,
                room: room || "A room",
                minutes: Math.floor(aging.callSec / 60),
                items: (o.items ?? "an order").slice(0, 200),
              },
            });
        }
      }
    }
    await c.query(
      `update orders set escalation_level = $3, escalated_at = coalesce(escalated_at, $4)
        where venue_id = $1 and id = $2 and status in ('ringing', 'held')`,
      [venueId, o.id, target, now.toString()],
    );
    await emitEvent(c, {
      venueId,
      type: "order.escalated",
      entityId: o.id,
      entityVersion: target,
    });
    moved++;
  }
  return moved;
}

export async function sweepEscalations(pool: pg.Pool, now: Temporal.Instant): Promise<number> {
  const venues = await pool.query<{ id: string }>("select id from venues_for_scheduler()");
  let moved = 0;
  for (const v of venues.rows)
    moved += await withVenue(pool, { venueId: v.id, requestId: "sweep:orders" }, (c) =>
      escalateOrders(c, v.id, now),
    );
  return moved;
}

export function escalationSweep(pool: pg.Pool): Sweep {
  return {
    name: "orders.escalate",
    everyMs: ESCALATION_EVERY_MS,
    run: async (now) => void (await sweepEscalations(pool, now)),
  };
}

/** Whole seconds since an instant, for the board's alert. */
export const secondsSince = (at: string, now: Temporal.Instant) =>
  Math.max(
    0,
    Math.floor((now.epochMilliseconds - Temporal.Instant.from(at).epochMilliseconds) / 1000),
  );
