import { venueModules, type Queryable } from "@west4/db";
import { clearOutDue } from "@west4/rules";
import { Temporal } from "@west4/shared";
import { alcoholVenue } from "../orders/alcohol.js";

/**
 * The checks before closing (M7-12; spec 08 · Night close; screens Night
 * note 1): each with how many are still open, who or what they are, and the
 * screen that fixes it. Every blocking check must be clear for the close;
 * paper slips not entered and tabs whose capture failed are shown and never
 * hold it up. With Team, time clock & tips off, the clock check drops out.
 * The manager closing the night doesn't count as "still on the clock": the
 * close clocks them out at the close time (the ticket's cautious default).
 */
export type CheckId =
  | "open_rooms"
  | "open_tabs"
  | "on_the_clock"
  | "waitlist"
  | "orders"
  | "approvals"
  | "cleaning"
  | "unsent"
  | "clear_out"
  | "drawers"
  | "slips"
  | "capture_failed";

export interface NightCheck {
  readonly id: CheckId;
  readonly count: number;
  readonly blocking: boolean;
  /** Names to show (people, tabs, rooms), or the due time for the clear-out check. */
  readonly names: readonly string[];
  /** The screen that fixes it. */
  readonly link: string;
  /** The clear-out check: when it's due, and who did it when. */
  readonly due_at?: string;
  readonly done?: { readonly by: string; readonly at: string } | null;
}

const count = async (c: Queryable, sql: string, args: unknown[]) =>
  (await c.query<{ name: string }>(sql, args)).rows.map((r) => r.name);

export async function nightChecks(
  c: Queryable,
  venueId: string,
  date: string,
  now: Temporal.Instant,
  exemptUserId: string | null,
): Promise<NightCheck[]> {
  const checks: NightCheck[] = [];
  const add = (id: CheckId, names: readonly string[], link: string, blocking = true) =>
    checks.push({ id, count: names.length, blocking: blocking && names.length > 0, names, link });

  add(
    "open_rooms",
    await count(
      c,
      `select r.name from room_sessions s join rooms r on r.venue_id = s.venue_id and r.id = s.room_id
        where s.venue_id = $1 and s.ended_at is null and not s.training order by r.name`,
      [venueId],
    ),
    "/tonight",
  );
  add(
    "open_tabs",
    await count(
      c,
      `select t.name from tabs t join checks k on k.venue_id = t.venue_id and k.id = t.check_id
        where t.venue_id = $1 and t.state in ('open', 'tipping') and not k.training order by t.opened_at`,
      [venueId],
    ),
    "/close-the-night",
  );
  const team = (await venueModules(c, venueId)).find((m) => m.module_id === "team");
  if (team?.state !== "off")
    add(
      "on_the_clock",
      await count(
        c,
        `select u.name from shifts s join memberships m on m.venue_id = s.venue_id and m.id = s.membership_id
           join users u on u.id = m.user_id
          where s.venue_id = $1 and s.ended_at is null and m.user_id is distinct from $2 order by s.started_at`,
        [venueId, exemptUserId],
      ),
      "/clock",
    );
  add(
    "waitlist",
    await count(
      c,
      `select coalesce(g.name, '') as name from waitlist_entries w left join guests g on g.id = w.guest_id
        where w.venue_id = $1 and w.status in ('waiting', 'offered') order by w.joined_at`,
      [venueId],
    ),
    "/tonight",
  );
  add(
    "orders",
    await count(
      c,
      `select coalesce(r.name, '') as name from orders o left join room_sessions s on s.venue_id = o.venue_id and s.id = o.session_id
         left join rooms r on r.venue_id = s.venue_id and r.id = s.room_id
        where o.venue_id = $1 and o.status in ('ringing', 'held') order by o.placed_at`,
      [venueId],
    ),
    "/bar-orders",
  );
  add(
    "approvals",
    await count(
      c,
      "select kind as name from approvals where venue_id = $1 and status = 'pending' order by requested_at",
      [venueId],
    ),
    "/approvals",
  );
  add(
    "cleaning",
    await count(
      c,
      `select r.name from room_states s join rooms r on r.venue_id = s.venue_id and r.id = s.room_id
        where s.venue_id = $1 and s.state = 'cleaning' order by r.name`,
      [venueId],
    ),
    "/tonight",
  );
  add(
    "unsent",
    await count(
      c,
      `select coalesce(t.name, u.name) as name from order_drafts d
         join memberships m on m.venue_id = d.venue_id and m.id = d.membership_id
         join users u on u.id = m.user_id
         left join tabs t on t.venue_id = d.venue_id and t.check_id = d.check_id
        where d.venue_id = $1 and jsonb_array_length(d.lines) > 0 order by d.updated_at`,
      [venueId],
    ),
    "/bar",
  );

  // The clear-out check: due after the drinking-up time; the close waits until someone's done it.
  const venue = await alcoholVenue(c, venueId, now);
  const due = clearOutDue(venue, Temporal.PlainDate.from(date));
  const done = (
    await c.query<{ by: string; at: string }>(
      `select split_part(u.name, ' ', 1) as by, to_json(k.done_at) #>> '{}' as at
         from clear_out_checks k join users u on u.id = k.done_by
        where k.venue_id = $1 and k.business_date = $2::date and k.done_at is not null`,
      [venueId, date],
    )
  ).rows[0];
  checks.push({
    id: "clear_out",
    count: done ? 0 : 1,
    blocking: !done,
    names: [],
    link: "/close-the-night",
    due_at: due.toString(),
    done: done ?? null,
  });

  // Every drawer session of the night counted, pulled trays included.
  add(
    "drawers",
    await count(
      c,
      `select coalesce(s.tray_label, d.name) as name from drawer_sessions s
         join cash_drawers d on d.venue_id = s.venue_id and d.id = s.drawer_id
        where s.venue_id = $1 and s.business_date = $2::date and s.state in ('open', 'pulled') order by d.name`,
      [venueId, date],
    ),
    "/close-the-night",
  );

  // Shown, never blocking.
  add(
    "slips",
    await count(
      c,
      `select t.name from tabs t join checks k on k.venue_id = t.venue_id and k.id = t.check_id
        where t.venue_id = $1 and t.state = 'awaiting_tip' and not k.training order by t.opened_at`,
      [venueId],
    ),
    "/tips",
    false,
  );
  add(
    "capture_failed",
    await count(
      c,
      "select name from tabs where venue_id = $1 and state = 'capture_failed' order by opened_at",
      [venueId],
    ),
    "/close-the-night",
    false,
  );
  return checks;
}
