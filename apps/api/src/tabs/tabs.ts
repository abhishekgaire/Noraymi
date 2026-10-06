import type { Queryable } from "@west4/db";
import { businessDate } from "@west4/rules";
import type { Temporal } from "@west4/shared";
import { checkView } from "../rooms/checks.js";
import { venueClock } from "../rooms/assignment.js";
import { holdView, tabOfCheck } from "./hold.js";
import { slipView } from "./tip.js";

/**
 * Bar tabs as the bar POS lists them (M6-02; API · Bar tabs; Staff screens and
 * the bar POS · The bar POS screen): open tabs in the order opened, each with
 * its card, hold, total and the badges that need attention (a cut-off, a fix
 * waiting for a manager, unsent drinks), and tonight's closed ones. A tab
 * waiting for the tip from its paper slip carries the slip (M6-09: Tips to
 * enter): its total, when it printed, its photo, and a tip_review it waits on.
 */
// A tab waiting for the tip from its signed paper slip is done at the bar: it leaves the open tabs for Tips
// to enter (M6-09), and lists with tonight's closed ones.
const OPEN = ["open", "tipping", "capture_failed"];

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
  // Someone else's drinks not sent yet on the tab ("1 not sent"); the caller sees their own in the round.
  const unsent = options.membershipId
    ? new Map(
        (
          await c.query<{ check_id: string; n: number }>(
            `select check_id, coalesce(sum((select sum((l->>'qty')::int) from jsonb_array_elements(lines) l)), 0)::int as n
               from order_drafts where venue_id = $1 and membership_id <> $2 and check_id is not null
              group by check_id`,
            [venueId, options.membershipId],
          )
        ).rows.map((r) => [r.check_id, r.n]),
      )
    : new Map<string, number>();
  return Promise.all(
    rows.map(async (t) => {
      const view = await checkView(c, venueId, t.check_id, now);
      // A round waiting for a manager after a declined hold raise (M6-07) also reads "Waiting for Andy".
      const overHold = (
        await c.query<{ name: string }>(
          `select u.name from approvals a join users u on u.id = a.routed_to
            where a.venue_id = $1 and a.kind = 'over_hold' and a.target_id = $2 and a.status = 'pending'
            order by a.requested_at limit 1`,
          [venueId, t.id],
        )
      ).rows[0]?.name;
      const slip = t.state === "awaiting_tip" ? await slipView(c, venueId, t.id) : null;
      const waiting =
        view.pending_fixes.find((f) => f.waiting_for)?.waiting_for ??
        overHold ??
        slip?.waiting_for ??
        null;
      const held = await tabOfCheck(c, venueId, t.check_id);
      // Paid beside the hold (M6-10): split shares by a new tap or in cash, captured or being charged.
      const beside = (
        await c.query<{ captured: number; charging: number }>(
          `select coalesce(sum(a.amount_cents) filter (where a.state = 'captured'), 0)::int as captured,
                  coalesce(sum(a.amount_cents) filter (where a.state = 'in_progress'), 0)::int as charging
             from payment_allocations a join tabs t on t.venue_id = a.venue_id and t.check_id = a.check_id
            where a.venue_id = $1 and a.check_id = $2 and a.payment_id is distinct from t.payment_id`,
          [venueId, t.check_id],
        )
      ).rows[0]!;
      const total = view.totals?.total_cents ?? 0;
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
        // The hold's headroom, a card that can't grow, a declined or unclear raise (M6-07).
        hold: held ? await holdView(c, venueId, held, now) : null,
        owner: t.owner_id ? { id: t.owner_id, name: t.owner_name } : null,
        opened_at: t.opened_at,
        closed_at: t.closed_at,
        totals: view.totals,
        amount_due_cents: view.amount_due_cents,
        // A split kept on the server: its shares and their states, and "Partly paid · $16.33 of $32.66".
        split: view.split
          ? {
              id: view.split.id,
              share_count: view.split.share_count,
              shares: view.split.shares.map((x) => ({
                id: x.id,
                share_no: x.share_no,
                amount_cents: x.amount_cents,
                state: x.state,
              })),
            }
          : null,
        paid_cents: beside.captured,
        // What the next charge is: always the rest.
        rest_cents: Math.max(0, total - beside.captured - beside.charging),
        cut_off: t.cut_off_at
          ? { at: t.cut_off_at, by: t.cut_off_by_name, reason: t.cut_off_reason }
          : null,
        waiting_for: waiting,
        unsent: unsent.get(t.check_id) ?? 0,
        slip,
      };
    }),
  );
}
