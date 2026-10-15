import type pg from "pg";
import { heldCardsOf } from "./held-card.js";
import { foodLines, type FoodLine } from "../kitchen/send.js";
import {
  amountDue,
  amountDueBesideHolds,
  checkById,
  depositsOn,
  emitEvent,
  openSplit,
  latestRevision,
  insertCheck,
  nextCheckNumber,
  withVenue,
  type Queryable,
} from "@west4/db";
import { formatCheckTime, type Temporal } from "@west4/shared";
import { venueClock } from "./assignment.js";
import { ApiError } from "../http/errors.js";
import { sessionViews } from "./sessions.js";
import { workOut } from "./finalize.js";
import { discountView } from "./discount.js";
import { savedCardFor } from "../payments/card-on-file.js";
import { checkPayments } from "./guest-bill.js";
import { cashPricer } from "../payments/surcharge.js";
import { businessDate } from "@west4/rules";
import { movableLines, movedHolds } from "../tabs/move.js";

/**
 * Room checks (M2-08; spec 04 · the money core). Opening one takes its number
 * from the venue's counter in its own short transaction first, then writes the
 * check in the caller's transaction. Check-in (M2-11) calls this.
 */
export async function openRoomCheck(
  pool: pg.Pool,
  input: {
    venueId: string;
    sessionId: string;
    bookingId: string | null;
    businessDate: string;
    openedBy: string;
    now: Temporal.Instant;
  },
): Promise<{ id: string; number: number }> {
  // A practice session's check is practice too (M7-03).
  const training = await withVenue(pool, { venueId: input.venueId }, async (c) => {
    const r = await c.query<{ training: boolean }>(
      "select training from room_sessions where venue_id = $1 and id = $2",
      [input.venueId, input.sessionId],
    );
    return r.rows[0]?.training ?? false;
  });
  const number = await nextCheckNumber(pool, input.venueId, { training });
  return withVenue(pool, { venueId: input.venueId, userId: input.openedBy }, async (c) => {
    const id = await insertCheck(c, {
      training,
      venueId: input.venueId,
      number,
      kind: "room",
      businessDate: input.businessDate,
      roomSessionId: input.sessionId,
      bookingId: input.bookingId,
      openedBy: input.openedBy,
      openedAt: input.now.toString(),
    });
    await c.query("update room_sessions set check_id = $3 where venue_id = $1 and id = $2", [
      input.venueId,
      input.sessionId,
      id,
    ]);
    await emitEvent(c, {
      venueId: input.venueId,
      type: "check.updated",
      entityId: id,
      entityVersion: 0,
    });
    return { id, number };
  });
}

/** A food line's kitchen state on the check view (K-05); a drink has none. */
const kitchenOf = (f: FoodLine | undefined) =>
  f
    ? {
        kitchen: {
          sent_at: f.sent_at,
          sent_by: f.sent_by,
          rung_at: f.rung_at,
          open_qty: f.open_qty,
          kitchen_note: f.kitchen_note,
          allergy: f.allergy,
          job_id: f.job_id,
        },
      }
    : {};

/** A check with its lines and the tab so far: room time so far (live, from its session) plus the lines. */
export async function checkView(c: Queryable, venueId: string, id: string, now: Temporal.Instant) {
  const found = await checkById(c, venueId, id);
  if (!found) throw new ApiError("not_found", "no such check");
  const session = found.check.room_session_id
    ? (await sessionViews(c, venueId, now, found.check.room_session_id))[0]
    : undefined;
  const roomTime = session?.clock.roomTimeCents ?? 0;
  const lines = found.lines.reduce((sum, l) => sum + l.amount_cents, 0);
  // Comps and voids waiting for approval (M3-19): the line shows "Waiting for Andy" on every screen.
  const pending = await c.query<{ line_id: string; kind: string; waiting_for: string }>(
    `select a.payload->>'line_id' as line_id, a.kind, u.name as waiting_for
       from approvals a join users u on u.id = a.routed_to
      where a.venue_id = $1 and a.target_id = $2 and a.status = 'pending' and a.kind in ('comp', 'void')
        and a.payload ? 'line_id'`,
    [venueId, id],
  );
  // Totals (M4-07): live from packages/rules while the check is open, the finalized revision's once presented.
  let totals: Record<string, number> | null = null;
  // The discount on the whole check (P-02): its stored lines once presented, worked out live before.
  let discountCents: number | null;
  if (["finalized", "partly_paid", "paid"].includes(found.check.status)) {
    const rev = await latestRevision(c, venueId, id);
    discountCents = -found.lines
      .filter((l) => l.kind === "discount")
      .reduce((s, l) => s + l.amount_cents, 0);
    if (rev)
      totals = {
        revision: rev.rev,
        subtotal_cents: rev.subtotal_cents,
        discount_cents: discountCents,
        tax_cents: rev.tax_cents,
        gratuity_cents: rev.gratuity_cents,
        total_cents: rev.total_cents,
      };
  } else {
    const worked = await workOut(c, venueId, found.check, found.lines, now).catch(() => null);
    discountCents = worked ? (worked.discount?.discountCents ?? 0) : null;
    if (worked)
      totals = {
        revision: found.check.revision,
        subtotal_cents: worked.totals.subtotalCents,
        discount_cents: discountCents ?? 0,
        tax_cents: worked.totals.taxCents,
        gratuity_cents: worked.totals.gratuityCents,
        total_cents: worked.totals.totalCents,
      };
  }
  // What's paid and what's left (M4-09): the deposits on it, and the amount due.
  const deposits = await depositsOn(c, venueId, id);
  // The holds of tabs moved into a room (M6-13) are its guarantee, shown with each tab's name, and left
  // out of what's due, since paying the room replaces them (Money rules 12).
  const holds = await movedHolds(c, venueId, id);
  const due = holds.length ? await amountDueBesideHolds(c, id) : await amountDue(c, id);
  const clock = await venueClock(c, venueId);
  // The cash price of what's due (U-02; Money rules 10): what cash would pay tonight with the cash
  // discount on, by the same rule as taking it, so the cash panel never works it out; null when off.
  const pricer = await cashPricer(
    c,
    venueId,
    businessDate(now, clock.timeZone, clock.dayCutover).businessDate.toString(),
  );
  const cashDue = pricer && due > 0 ? await pricer({ checkId: id, amountCents: due }) : null;
  // Moved lines name the check on the other side: "Moved from Jess P.'s bar tab", "Moved to Room 9".
  // Which lines are alcohol, for the fix panel's Move to grey out cut-off tabs (M6-13).
  const alcohol = new Set(
    (await movableLines(c, venueId, id)).filter((l) => l.alcohol).map((l) => l.id),
  );
  const moved = new Map(
    (
      await c.query<{ id: string; tab: string | null; room: string | null }>(
        `select l.id, t.name as tab, r.name as room
           from check_lines l
           left join tabs t on t.venue_id = l.venue_id and t.check_id = l.moved_check_id
           left join checks k on k.venue_id = l.venue_id and k.id = l.moved_check_id
           left join room_sessions s on s.venue_id = k.venue_id and s.id = k.room_session_id
           left join rooms r on r.venue_id = s.venue_id and r.id = s.room_id
          where l.venue_id = $1 and l.check_id = $2 and l.moved_check_id is not null`,
        [venueId, id],
      )
    ).rows.map((r) => [Number(r.id), { tab: r.tab, room: r.room }]),
  );
  // Packages (K-09): a package's lines are grouped under its name on the bill.
  const inPackage = new Map(
    (
      await c.query<{ id: string; package_id: string; name: string }>(
        `select l.id, p.id as package_id, p.name
           from check_lines l
           join order_items oi on oi.venue_id = l.venue_id and oi.id = l.source_id
           join packages p on p.venue_id = oi.venue_id and p.id = oi.package_id
          where l.venue_id = $1 and l.check_id = $2 and l.kind = 'item'`,
        [venueId, id],
      )
    ).rows.map((r) => [Number(r.id), { id: r.package_id, name: r.name }]),
  );
  // Components (K-12): a meal's fries and Coke name the line they came with, which they come off with.
  const partOf = new Map(
    (
      await c.query<{ id: string; parent: string }>(
        `select p.id, l.id as parent
           from check_lines p
           join order_items oi on oi.venue_id = p.venue_id and oi.id = p.source_id
           join check_lines l on l.venue_id = p.venue_id and l.check_id = p.check_id
                             and l.source_id = oi.parent_item_id and l.kind = 'item'
          where p.venue_id = $1 and p.check_id = $2 and p.kind = 'item'`,
        [venueId, id],
      )
    ).rows.map((r) => [Number(r.id), Number(r.parent)]),
  );
  // Food (K-05): each food line's Not sent or "Sent · 11:42", for the tab, the room and the sale.
  const food = new Map((await foodLines(c, venueId, id)).map((f) => [f.line_id, f]));
  // Card on file (M4-17): the deposit's card, and a charge waiting for the guest or a manager, if any.
  const saved = await savedCardFor(c, venueId, id);
  const waiting = saved
    ? (
        await c.query<{ id: string }>(
          `select p.id from payments p join payment_allocations a on a.venue_id = p.venue_id and a.payment_id = p.id
            where p.venue_id = $1 and a.check_id = $2 and p.method = 'card_on_file' and p.status = 'pending'
              and a.state = 'in_progress' order by p.created_at desc limit 1`,
          [venueId, id],
        )
      ).rows[0]
    : undefined;
  return {
    // Each payment as it lands (M4-18): "Paid by a guest · Kevin (share 1 of 12) $41.55".
    payments: await checkPayments(c, venueId, id),
    on_file: saved
      ? {
          brand: saved.brand,
          last4: saved.last4,
          guest_name: saved.guest_first_name,
          payment_id: waiting?.id ?? null,
        }
      : null,
    // A card kept behind the bar (O-08; D116): close-out ends with "Give the card back".
    held_card: (await heldCardsOf(c, venueId, [id])).get(id) ?? null,
    // The open split, if any (M4-14): it survives leaving the screen and switching devices.
    split: await openSplit(c, venueId, id).then(
      async (split) =>
        split && {
          ...split,
          // Each share still to pay carries its cash price with the cash discount on (U-03, D133).
          shares: await Promise.all(
            split.shares.map(async (x) => ({
              ...x,
              cash_cents:
                pricer && x.state !== "paid"
                  ? await pricer({ checkId: id, amountCents: x.amount_cents })
                  : null,
            })),
          ),
        },
    ),
    deposit_cents: deposits.reduce((sum, d) => sum + d.amount_cents, 0),
    amount_due_cents: due,
    cash_due_cents: cashDue,
    check: {
      ...found.check,
      label: `#${found.check.number}`,
      opened_label: formatCheckTime(found.check.opened_at, clock.timeZone),
    },
    totals,
    ...(await discountView(c, venueId, id, discountCents)),
    lines: found.lines.map((l) => {
      const m = moved.get(l.id);
      return m
        ? {
            ...l,
            alcohol: alcohol.has(l.id),
            moved:
              l.kind === "transfer_in"
                ? { from_tab: m.tab, from_room: m.room }
                : { to_tab: m.tab, to_room: m.room },
          }
        : {
            ...l,
            alcohol: alcohol.has(l.id),
            ...kitchenOf(food.get(Number(l.id))),
            ...(inPackage.has(Number(l.id)) ? { package: inPackage.get(Number(l.id)) } : {}),
            ...(partOf.has(Number(l.id)) ? { part_of: partOf.get(Number(l.id)) } : {}),
          };
    }),
    holds: holds.map((h) => ({ tab_id: h.tab_id, name: h.name, cents: h.hold_cents })),
    pending_fixes: pending.rows.map((p) => ({
      line_id: Number(p.line_id),
      kind: p.kind,
      waiting_for: p.waiting_for,
    })),
    room_time_cents: roomTime,
    minutes: session?.clock.minutes ?? null,
    lines_cents: lines,
    tab_so_far_cents: roomTime + lines,
  };
}
