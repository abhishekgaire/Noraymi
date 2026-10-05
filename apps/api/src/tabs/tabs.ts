import type { Queryable } from "@west4/db";
import { businessDate } from "@west4/rules";
import type { Temporal } from "@west4/shared";
import { checkView } from "../rooms/checks.js";
import { venueClock } from "../rooms/assignment.js";

/**
 * Bar tabs as the bar POS lists them (M6-02; API · Bar tabs; Staff screens and
 * the bar POS · The bar POS screen): open tabs in the order opened, each with
 * its card, hold, total and the badges that need attention (a cut-off, a fix
 * waiting for a manager, unsent drinks), and tonight's closed ones.
 */
const OPEN = ["open", "tipping", "awaiting_tip", "capture_failed"];

interface TabRow {
  id: string;
  check_id: string;
  state: string;
  name: string;
  label: string | null;
  card_brand: string | null;
  card_last4: string | null;
  hold_cents: number;
  owner_id: string | null;
  owner_name: string | null;
  opened_at: string;
  cut_off_at: string | null;
  cut_off_by_name: string | null;
  cut_off_reason: string | null;
  closed_at: string | null;
  business_date: string;
}

export async function listTabs(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
  options: { state?: string | undefined; membershipId?: string | null } = {},
) {
  const venue = await venueClock(c, venueId);
  const today = businessDate(now, venue.timeZone, venue.dayCutover).businessDate.toString();
  const states = options.state ? options.state.split(",") : null;
  const rows = (
    await c.query<TabRow>(
      `select t.id, t.check_id, t.state, t.name, t.label, t.card_brand, t.card_last4, t.hold_cents,
              t.owner_id, split_part(o.name, ' ', 1) as owner_name, to_json(t.opened_at) #>> '{}' as opened_at,
              to_json(t.cut_off_at) #>> '{}' as cut_off_at, split_part(cb.name, ' ', 1) as cut_off_by_name,
              t.cut_off_reason, to_json(t.closed_at) #>> '{}' as closed_at, k.business_date::text
         from tabs t join checks k on k.venue_id = t.venue_id and k.id = t.check_id
         left join users o on o.id = t.owner_id
         left join users cb on cb.id = t.cut_off_by
        where t.venue_id = $1 and ($2::text[] is not null and t.state = any($2) or $2::text[] is null and
              (t.state = any($3) or k.business_date = $4::date))
        order by t.opened_at, t.id`,
      [venueId, states, OPEN, today],
    )
  ).rows;
  const unsent = options.membershipId
    ? new Map(
        (
          await c.query<{ check_id: string; n: number }>(
            `select check_id, coalesce((select sum((l->>'qty')::int) from jsonb_array_elements(lines) l), 0)::int as n
               from order_drafts where venue_id = $1 and membership_id = $2 and check_id is not null`,
            [venueId, options.membershipId],
          )
        ).rows.map((r) => [r.check_id, r.n]),
      )
    : new Map<string, number>();
  return Promise.all(
    rows.map(async (t) => {
      const view = await checkView(c, venueId, t.check_id, now);
      const waiting = view.pending_fixes.find((f) => f.waiting_for)?.waiting_for ?? null;
      return {
        id: t.id,
        check_id: t.check_id,
        check_label: view.check.label,
        state: t.state,
        open: OPEN.includes(t.state),
        name: t.name,
        label: t.label,
        card: t.card_last4 ? { brand: t.card_brand, last4: t.card_last4 } : null,
        hold_cents: t.hold_cents,
        owner: t.owner_id ? { id: t.owner_id, name: t.owner_name } : null,
        opened_at: t.opened_at,
        closed_at: t.closed_at,
        totals: view.totals,
        amount_due_cents: view.amount_due_cents,
        cut_off: t.cut_off_at
          ? { at: t.cut_off_at, by: t.cut_off_by_name, reason: t.cut_off_reason }
          : null,
        waiting_for: waiting,
        unsent: unsent.get(t.check_id) ?? 0,
      };
    }),
  );
}
