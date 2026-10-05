import type pg from "pg";
import {
  clearDraft,
  draftFor,
  emitEvent,
  insertCheck,
  menuTree,
  saveDraft,
  nextCheckNumber,
  readSetting,
  type Queryable,
} from "@west4/db";
import { businessDate, tipChoices } from "@west4/rules";
import type { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { placeStaffOrder, type StaffLine } from "../orders/place.js";
import { checkView } from "../rooms/checks.js";
import { finalizeCheck } from "../rooms/finalize.js";
import { venueClock } from "../rooms/assignment.js";

/**
 * Quick sale (M6-05; Staff screens and the bar POS · Paying at the bar): a
 * walk-up sale with no tab. Pay makes a `quick` check of its own, puts the
 * person's rung drinks on it as a staff order accepted at once (the ticket
 * prints), finalizes it, and empties their quick draft; the pay panel then
 * takes a tap or cash. The number comes from the venue's counter first, in
 * its own short transaction, so a failed tap later keeps it.
 */
export async function quickSaleNumber(pool: pg.Pool, venueId: string) {
  return nextCheckNumber(pool, venueId);
}

export async function startQuickSale(
  c: Queryable,
  venueId: string,
  input: {
    number: number;
    lines: readonly StaffLine[];
    clientOrderId: string;
    userId: string;
    membershipId: string;
    deviceId: string | null;
    now: Temporal.Instant;
  },
) {
  // A retried Pay answers the sale it made the first time.
  const seen = (
    await c.query<{ check_id: string }>(
      `select o.check_id from orders o join checks k on k.venue_id = o.venue_id and k.id = o.check_id
        where o.venue_id = $1 and o.client_order_id = $2 and k.kind = 'quick'`,
      [venueId, input.clientOrderId],
    )
  ).rows[0];
  if (seen) return quickSaleView(c, venueId, seen.check_id, input.now);
  if (input.lines.length === 0)
    throw new ApiError("invalid_request", "ring a drink first", { details: { reason: "empty" } });
  const venue = await venueClock(c, venueId);
  const date = businessDate(input.now, venue.timeZone, venue.dayCutover).businessDate.toString();
  const checkId = await insertCheck(c, {
    venueId,
    number: input.number,
    kind: "quick",
    businessDate: date,
    openedBy: input.userId,
    openedAt: input.now.toString(),
  });
  await placeStaffOrder(c, venueId, {
    checkId,
    lines: input.lines,
    clientOrderId: input.clientOrderId,
    userId: input.userId,
    membershipId: input.membershipId,
    deviceId: input.deviceId,
    now: input.now,
  });
  await finalizeCheck(c, venueId, checkId, { userId: input.userId, now: input.now });
  await c.query("update checks set status = 'finalized' where venue_id = $1 and id = $2", [
    venueId,
    checkId,
  ]);
  const version = await clearDraft(c, venueId, input.membershipId, null, input.now.toString());
  if (version !== null)
    await emitEvent(c, {
      venueId,
      type: "draft.updated",
      entityId: "quick",
      entityVersion: version,
      audience: "user",
      userId: input.userId,
    });
  await emitEvent(c, { venueId, type: "check.updated", entityId: checkId });
  return quickSaleView(c, venueId, checkId, input.now);
}

/** The sale as the pay panel shows it, with the tip choices the reader will offer. */
export async function quickSaleView(
  c: Queryable,
  venueId: string,
  checkId: string,
  now: Temporal.Instant,
) {
  const view = await checkView(c, venueId, checkId, now);
  const drinks = view.lines
    .filter((l) => ["item", "comp", "void", "discount"].includes(l.kind))
    .reduce((sum, l) => sum + l.amount_cents, 0);
  const venue = await venueClock(c, venueId);
  const pay = await readSetting(
    c,
    venueId,
    "pay",
    businessDate(now, venue.timeZone, venue.dayCutover).businessDate,
  );
  const choices = pay ? tipChoices(drinks, pay.value.tipScreen) : null;
  return {
    check_id: checkId,
    check_label: view.check.label,
    totals: view.totals,
    amount_due_cents: view.amount_due_cents,
    drinks_before_tax_cents: drinks,
    tip_choices: choices ? { kind: choices.kind, choices_cents: choices.choicesCents } : null,
    lines: view.lines.filter((l) => !["tax", "gratuity", "room_time"].includes(l.kind)),
  };
}

/**
 * Back to the sale (M6-05): a quick sale nobody paid (a tap declined, or the
 * guest changed their mind) is voided and keeps its number, and its drinks go
 * back into the person's quick sale to pay another way or move onto a tab.
 */
export async function backToTheSale(
  c: Queryable,
  venueId: string,
  checkId: string,
  who: { userId: string; membershipId: string; deviceId: string | null; now: Temporal.Instant },
) {
  const check = (
    await c.query<{ kind: string; status: string }>(
      "select kind, status from checks where venue_id = $1 and id = $2 for update",
      [venueId, checkId],
    )
  ).rows[0];
  if (!check || check.kind !== "quick") throw new ApiError("not_found", "no such sale");
  if (check.status !== "finalized")
    throw new ApiError("invalid_request", `this sale is ${check.status}`, {
      details: { reason: check.status },
    });
  const paid = await c.query(
    // Money taken or held, or a tap still on the reader; a declined or cancelled tap doesn't count.
    `select 1 from payments p join payment_allocations a on a.venue_id = p.venue_id and a.payment_id = p.id
      where p.venue_id = $1 and a.check_id = $2
        and (p.status in ('authorized', 'captured', 'capture_failed', 'partly_refunded')
             or (p.status in ('pending', 'requires_action') and exists (
                   select 1 from payment_attempts t where t.venue_id = p.venue_id and t.payment_id = p.id
                     and t.state in ('started', 'unknown'))))`,
    [venueId, checkId],
  );
  if ((paid.rowCount ?? 0) > 0)
    throw new ApiError("invalid_request", "a payment on this sale is in progress or taken", {
      details: { reason: "paid" },
    });
  await c.query("update checks set status = 'void' where venue_id = $1 and id = $2", [
    venueId,
    checkId,
  ]);

  // Its drinks, back in the person's quick sale, with the options they had.
  const items = (
    await c.query<{
      item_id: string | null;
      variant_id: string | null;
      qty: number;
      options: { group: string; name: string }[];
    }>(
      `select i.item_id, i.variant_id, i.qty, i.options from order_items i
         join orders o on o.venue_id = i.venue_id and o.id = i.order_id
        where i.venue_id = $1 and o.check_id = $2 order by i.sort, i.id`,
      [venueId, checkId],
    )
  ).rows;
  const menu = (
    await menuTree(c, venueId, new Date(who.now.epochMilliseconds).toISOString())
  ).flatMap((cat) => cat.items);
  const back = items
    .filter((i) => i.variant_id !== null)
    .map((i) => {
      const item = menu.find((m) => m.id === i.item_id);
      return {
        variant_id: i.variant_id!,
        qty: i.qty,
        option_ids: (i.options ?? []).flatMap((o) => {
          const found = item?.groups
            .find((g) => g.name === o.group)
            ?.options.find((x) => x.name === o.name);
          return found ? [found.id] : [];
        }),
      };
    });
  const draft = await draftFor(c, venueId, who.membershipId, null);
  const version = await saveDraft(c, venueId, {
    membershipId: who.membershipId,
    checkId: null,
    deviceId: who.deviceId,
    lines: [...((draft?.lines ?? []) as unknown[]), ...back],
    version: draft?.version ?? 0,
    at: who.now.toString(),
  });
  if (version !== null)
    await emitEvent(c, {
      venueId,
      type: "draft.updated",
      entityId: "quick",
      entityVersion: version,
      audience: "user",
      userId: who.userId,
    });
  await emitEvent(c, { venueId, type: "check.updated", entityId: checkId });
  return { check_id: checkId, status: "void", lines: back.length };
}
