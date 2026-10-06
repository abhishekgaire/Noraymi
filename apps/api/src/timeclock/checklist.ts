import { managerOnDuty, type Queryable } from "@west4/db";

/**
 * The clock-out checklist (M7-11; spec 10 · Shifts; screens N24): what's
 * left before a person can clock out, each line with what fixes it.
 *   open_tab        a bar tab of theirs still open: hand it to someone still on
 *   unsent          drinks rung but not sent: they go with their tab, or clear them
 *   staff_bank      cash they hold outside a drawer: drop it into a drawer
 *   own_drawer      their own drawer (a drawer per person): count it now or pull the tray
 *   declare_tips    cash tips to declare, any amount, $0.00 included
 *   drawer_handover the manager on duty, with another manager on: hand the drawers over
 */
export type ChecklistItem =
  | {
      readonly kind: "open_tab";
      readonly tab_id: string;
      readonly name: string;
      readonly label: string | null;
    }
  | {
      readonly kind: "unsent";
      readonly check_id: string | null;
      readonly tab_id: string | null;
      readonly tab_name: string | null;
      readonly drinks: number;
    }
  | { readonly kind: "staff_bank"; readonly cash_cents: number }
  | { readonly kind: "own_drawer"; readonly drawer_id: string; readonly drawer: string }
  | { readonly kind: "declare_tips"; readonly shift_id: string }
  | { readonly kind: "drawer_handover" };

export async function clockOutChecklist(
  c: Queryable,
  venueId: string,
  who: { readonly userId: string; readonly membershipId: string; readonly role: string },
): Promise<ChecklistItem[]> {
  const items: ChecklistItem[] = [];
  const shift = (
    await c.query<{ id: string; business_date: string; duty: string; declared: boolean }>(
      `select id, business_date::text, duty, cash_tips_declared_at is not null as declared from shifts
        where venue_id = $1 and membership_id = $2 and ended_at is null`,
      [venueId, who.membershipId],
    )
  ).rows[0];
  if (!shift) return items;

  const tabs = await c.query<{ id: string; name: string; label: string | null }>(
    "select id, name, label from tabs where venue_id = $1 and owner_id = $2 and state = 'open' order by opened_at",
    [venueId, who.userId],
  );
  for (const t of tabs.rows)
    items.push({ kind: "open_tab", tab_id: t.id, name: t.name, label: t.label });

  const drafts = await c.query<{
    check_id: string | null;
    tab_id: string | null;
    tab_name: string | null;
    drinks: number;
  }>(
    `select d.check_id, t.id as tab_id, t.name as tab_name,
            (select coalesce(sum((l ->> 'qty')::int), 0) from jsonb_array_elements(d.lines) l)::int as drinks
       from order_drafts d left join tabs t on t.venue_id = d.venue_id and t.check_id = d.check_id
      where d.venue_id = $1 and d.membership_id = $2 and jsonb_array_length(d.lines) > 0
      order by t.opened_at nulls last`,
    [venueId, who.membershipId],
  );
  for (const d of drafts.rows) items.push({ kind: "unsent", ...d });

  const bank = await c.query<{ cash_cents: number }>(
    `select cash_cents::int as cash_cents from staff_banks
      where venue_id = $1 and user_id = $2 and business_date = $3::date and cash_cents > 0`,
    [venueId, who.userId, shift.business_date],
  );
  if (bank.rows[0]) items.push({ kind: "staff_bank", cash_cents: bank.rows[0].cash_cents });

  const own = await c.query<{ drawer_id: string; name: string }>(
    `select s.drawer_id, d.name from drawer_sessions s join cash_drawers d on d.venue_id = s.venue_id and d.id = s.drawer_id
      where s.venue_id = $1 and s.owner_id = $2 and s.model = 'per_person' and s.state = 'open'`,
    [venueId, who.userId],
  );
  for (const o of own.rows)
    items.push({ kind: "own_drawer", drawer_id: o.drawer_id, drawer: o.name });

  // Owners and managers don't share tips; everyone else declares their cash tips, $0.00 included.
  if (who.role !== "owner" && who.role !== "manager" && !shift.declared)
    items.push({ kind: "declare_tips", shift_id: shift.id });

  // The manager on duty, with another manager on: the drawers go to them first.
  if (shift.duty === "manager" && (await managerOnDuty(c, venueId)) === who.userId) {
    const other = await c.query(
      `select 1 from shifts s join memberships m on m.venue_id = s.venue_id and m.id = s.membership_id
        where s.venue_id = $1 and s.ended_at is null and s.duty = 'manager' and m.user_id <> $2
          and m.role in ('owner', 'manager') and m.status = 'active'`,
      [venueId, who.userId],
    );
    const house = await c.query(
      "select 1 from drawer_sessions where venue_id = $1 and model = 'house' and state = 'open' and responsible_id = $2",
      [venueId, who.userId],
    );
    if ((other.rowCount ?? 0) > 0 && (house.rowCount ?? 0) > 0)
      items.push({ kind: "drawer_handover" });
  }
  return items;
}
