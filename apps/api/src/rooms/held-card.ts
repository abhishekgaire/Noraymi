import { statesOf, venueModules, type Queryable } from "@west4/db";
import { stateOf, type Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";

/**
 * Keep the card behind the bar (O-08; D116; spec 03 · DepositRule.walkIn
 * "cardBehindBar"). After a walk-in is seated, staff keep the guest's physical
 * card and type the name on it and its last 4 digits onto the room's check.
 * No reader, no Stripe call, nothing charged. A full card number is never
 * accepted: the last 4 are exactly four digits, and the name may hold no digit
 * at all. Close-out ends with "Give the card back" (Returned); Close the night
 * lists a card not returned; the close clears the name and last 4, keeping who
 * took and returned the card and when. Neither ever reaches a log.
 */
export interface HeldCard {
  readonly name: string | null;
  readonly last4: string | null;
  readonly taken_at: string;
  readonly returned: boolean;
  readonly returned_at: string | null;
}

/** The name and last 4 as typed, checked; null when either is wrong (never echoed back). */
export function parseHeldCard(body: unknown): { name: string; last4: string } | null {
  if (typeof body !== "object" || body === null) return null;
  const keys = Object.keys(body);
  if (keys.length !== 2 || !keys.includes("name") || !keys.includes("last4")) return null;
  const { name, last4 } = body as { name: unknown; last4: unknown };
  if (typeof name !== "string" || typeof last4 !== "string") return null;
  const n = name.trim().replace(/\s+/g, " ");
  if (n.length < 1 || n.length > 60 || /\d/.test(n)) return null;
  if (!/^\d{4}$/.test(last4)) return null;
  return { name: n, last4 };
}

const view = (r: {
  guest_name: string | null;
  last4: string | null;
  taken_at: Date;
  returned_at: Date | null;
}): HeldCard => ({
  name: r.guest_name,
  last4: r.last4,
  taken_at: r.taken_at.toISOString(),
  returned: r.returned_at !== null,
  returned_at: r.returned_at?.toISOString() ?? null,
});

/** The held card of each check, by check id. */
export async function heldCardsOf(
  c: Queryable,
  venueId: string,
  checkIds: readonly string[],
): Promise<Map<string, HeldCard>> {
  const out = new Map<string, HeldCard>();
  if (checkIds.length === 0) return out;
  const r = await c.query<{
    check_id: string;
    guest_name: string | null;
    last4: string | null;
    taken_at: Date;
    returned_at: Date | null;
  }>(
    `select check_id, guest_name, last4, taken_at, returned_at from check_held_cards
      where venue_id = $1 and check_id = any($2::uuid[])`,
    [venueId, checkIds],
  );
  for (const row of r.rows) out.set(row.check_id, view(row));
  return out;
}

/** Save the card on an open room check; one card a check. */
export async function takeHeldCard(
  c: Queryable,
  venueId: string,
  checkId: string,
  card: { name: string; last4: string },
  by: string,
  now: Temporal.Instant,
): Promise<HeldCard> {
  const check = (
    await c.query<{ kind: string; status: string; business_date: string }>(
      `select kind, status, business_date::text from checks where venue_id = $1 and id = $2 for update`,
      [venueId, checkId],
    )
  ).rows[0];
  if (!check) throw new ApiError("not_found", "no such check");
  if (check.kind !== "room")
    throw new ApiError("invalid_request", "a card is kept behind the bar for a room's check only");
  if (check.status !== "open") throw new ApiError("version_conflict", "this check isn't open");
  const inserted = await c.query<{
    guest_name: string | null;
    last4: string | null;
    taken_at: Date;
    returned_at: Date | null;
  }>(
    `insert into check_held_cards (venue_id, check_id, business_date, guest_name, last4, taken_by, taken_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (venue_id, check_id) do nothing
     returning guest_name, last4, taken_at, returned_at`,
    [venueId, checkId, check.business_date, card.name, card.last4, by, now.toString()],
  );
  if (!inserted.rows[0])
    throw new ApiError("version_conflict", "this check already has a card behind the bar");
  return view(inserted.rows[0]);
}

/** Give the card back: who and when. Once only. */
export async function returnHeldCard(
  c: Queryable,
  venueId: string,
  checkId: string,
  by: string,
  now: Temporal.Instant,
): Promise<HeldCard> {
  const r = await c.query<{
    guest_name: string | null;
    last4: string | null;
    taken_at: Date;
    returned_at: Date | null;
  }>(
    `update check_held_cards set returned_by = $3, returned_at = $4
      where venue_id = $1 and check_id = $2 and returned_at is null
      returning guest_name, last4, taken_at, returned_at`,
    [venueId, checkId, by, now.toString()],
  );
  if (r.rows[0]) return view(r.rows[0]);
  const held = (await heldCardsOf(c, venueId, [checkId])).get(checkId);
  if (!held) throw new ApiError("not_found", "no card behind the bar for this check");
  return held;
}

/** At the business date's close: the name and last 4 are cleared, who and when stay. */
export async function clearHeldCards(
  c: Queryable,
  venueId: string,
  businessDate: string,
  now: Temporal.Instant,
): Promise<number> {
  const r = await c.query(
    `update check_held_cards set guest_name = null, last4 = null, cleared_at = $3
      where venue_id = $1 and business_date <= $2::date and cleared_at is null`,
    [venueId, businessDate, now.toString()],
  );
  return r.rowCount ?? 0;
}

/** Whether Keep the card behind the bar (D124) is on at the venue. */
export async function cardBehindBarOn(c: Queryable, venueId: string): Promise<boolean> {
  return stateOf(statesOf(await venueModules(c, venueId)), "card_behind_bar") === "on";
}

/**
 * The card behind the bar on a bar tab (U-23; D134): the name on the card and its last 4, each
 * optional (null or absent), never the full number. Checked as for a room: no digit in the name,
 * exactly four digits in the last 4.
 */
export interface TabHeldCardInput {
  readonly name: string | null;
  readonly last4: string | null;
}
export function parseTabHeldCard(body: unknown): TabHeldCardInput | null {
  if (typeof body !== "object" || body === null) return null;
  const keys = Object.keys(body);
  if (keys.some((k) => k !== "name" && k !== "last4")) return null;
  const { name, last4 } = body as { name?: unknown; last4?: unknown };
  let n: string | null = null;
  if (name !== undefined && name !== null) {
    if (typeof name !== "string") return null;
    const t = name.trim().replace(/\s+/g, " ");
    if (t.length > 60 || /\d/.test(t)) return null;
    n = t.length > 0 ? t : null;
  }
  let l: string | null = null;
  if (last4 !== undefined && last4 !== null && last4 !== "") {
    if (typeof last4 !== "string" || !/^\d{4}$/.test(last4)) return null;
    l = last4;
  }
  return { name: n, last4: l };
}

/** Keep the card behind the bar on a tab just opened by name (inside its transaction). */
export async function takeTabHeldCard(
  c: Queryable,
  venueId: string,
  input: {
    checkId: string;
    tabId: string;
    businessDate: string;
    card: TabHeldCardInput;
    by: string;
    now: Temporal.Instant;
  },
): Promise<HeldCard> {
  const r = await c.query<{
    guest_name: string | null;
    last4: string | null;
    taken_at: Date;
    returned_at: Date | null;
  }>(
    `insert into check_held_cards (venue_id, check_id, tab_id, business_date, guest_name, last4, taken_by, taken_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning guest_name, last4, taken_at, returned_at`,
    [
      venueId,
      input.checkId,
      input.tabId,
      input.businessDate,
      input.card.name,
      input.card.last4,
      input.by,
      input.now.toString(),
    ],
  );
  return view(r.rows[0]!);
}

/**
 * A tab moved into a room carries its card behind the bar to the room's check (U-23), unless the room
 * already keeps one: then it stays on the tab's check, still listed on Close the night until Returned.
 */
export async function moveTabHeldCard(
  c: Queryable,
  venueId: string,
  tabId: string,
  toCheckId: string,
): Promise<boolean> {
  const r = await c.query(
    `update check_held_cards h set check_id = $3
      where h.venue_id = $1 and h.tab_id = $2 and h.returned_at is null
        and not exists (select 1 from check_held_cards o where o.venue_id = $1 and o.check_id = $3)`,
    [venueId, tabId, toCheckId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Undo the move: the tab's card goes back onto the tab's own check. */
export async function returnTabHeldCardToTab(
  c: Queryable,
  venueId: string,
  tabId: string,
  tabCheckId: string,
): Promise<void> {
  await c.query(
    `update check_held_cards set check_id = $3
      where venue_id = $1 and tab_id = $2 and check_id <> $3`,
    [venueId, tabId, tabCheckId],
  );
}
