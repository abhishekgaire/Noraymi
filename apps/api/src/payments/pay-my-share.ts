import {
  allocate,
  amountDue,
  insertPayment,
  openSplit,
  readSetting,
  startAttempt,
  type Queryable,
} from "@west4/db";
import { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { startSplit } from "./splits.js";

/**
 * Pay my share (M4-18; Money rules 13; Payment flows · Pay my share; screens
 * N6): a guest pays their own part of the presented check from their phone.
 * The check's split is kept on the server (one per check, shared with staff's
 * split): it starts at the party size, over what was left to pay then, so a
 * share doesn't change as others pay. Each guest takes their own share (a row
 * lock, so two guests at once never get the same one), and pays at most what's
 * still due, on our payment page. The payment's allocation names the guest, so
 * the room tab reads "Paid by a guest · Kevin (share 1 of 12) $41.55".
 */
export interface MyShare {
  readonly share_id: string;
  readonly share_no: number;
  readonly shares: number;
  readonly share_cents: number;
  readonly tax_cents: number;
  readonly gratuity_cents: number;
  /** What this guest pays now: their share, or less if others paid more meanwhile. */
  readonly amount_cents: number;
  readonly state: "open" | "paying" | "paid";
  readonly payment_id: string | null;
}

/** Whether the venue offers Pay my share tonight (`pay.payShare`, on at West 4). */
export async function payShareOn(c: Queryable, venueId: string, businessDate: string) {
  const pay = await readSetting(c, venueId, "pay", Temporal.PlainDate.from(businessDate));
  return pay?.value.payShare.on ?? false;
}

/** "My items": each line a guest ordered from their phone, as a claim for their share number. */
async function itemClaims(c: Queryable, venueId: string, checkId: string) {
  const r = await c.query<{ line_id: string; room_guest_id: string }>(
    `select l.id as line_id, o.room_guest_id
       from check_lines l
       join order_items i on i.venue_id = l.venue_id and i.id = l.source_id
       join orders o on o.venue_id = i.venue_id and o.id = i.order_id
      where l.venue_id = $1 and l.check_id = $2 and l.kind = 'item' and o.room_guest_id is not null
      order by o.placed_at, l.id`,
    [venueId, checkId],
  );
  const guests: string[] = [];
  const claims: Record<string, number> = {};
  for (const row of r.rows) {
    if (!guests.includes(row.room_guest_id)) guests.push(row.room_guest_id);
    claims[row.line_id] = guests.indexOf(row.room_guest_id);
  }
  return { guests, claims };
}

export async function startMyShare(
  c: Queryable,
  venueId: string,
  input: {
    checkId: string;
    roomGuestId: string;
    partySize: number;
    kind: "even" | "items";
    name: string | null;
    businessDate: string;
    now: Temporal.Instant;
  },
): Promise<MyShare | null> {
  if (!(await payShareOn(c, venueId, input.businessDate)))
    throw new ApiError("forbidden", "Pay my share is off here");
  const check = (
    await c.query<{ status: string }>(
      "select status from checks where venue_id = $1 and id = $2 for update",
      [venueId, input.checkId],
    )
  ).rows[0];
  if (!check) throw new ApiError("not_found", "no such check");
  if (check.status === "paid") return null;
  if (check.status !== "finalized" && check.status !== "partly_paid")
    throw new ApiError("invalid_request", "the bill isn't ready yet");
  if (input.name)
    await c.query("update room_guests set name = $3 where venue_id = $1 and id = $2", [
      venueId,
      input.roomGuestId,
      input.name,
    ]);

  let split = await openSplit(c, venueId, input.checkId);
  if (!split) {
    // The first guest's choice starts the split: even, or by item (their own items, plus an even part
    // of room time and of lines nobody claimed, Money rules 13), over the party size.
    const people = Math.max(2, input.partySize);
    if (input.kind === "items") {
      const { guests, claims } = await itemClaims(c, venueId, input.checkId);
      split = await startSplit(
        c,
        venueId,
        input.checkId,
        { kind: "items", people: Math.max(people, guests.length), claims },
        { userId: input.roomGuestId, now: input.now },
      );
      // Each guest who ordered from their phone has the share with their items.
      for (const [i, guest] of guests.entries())
        await c.query(
          `update split_shares set room_guest_id = $3
            where venue_id = $1 and split_id = $2 and share_no = $4 and room_guest_id is null`,
          [venueId, split.id, guest, i + 1],
        );
    } else
      split = await startSplit(
        c,
        venueId,
        input.checkId,
        { kind: "even", shares: people },
        { userId: input.roomGuestId, now: input.now },
      );
  }
  const shareCount = (
    await c.query<{ n: number }>(
      "select count(*)::int as n from split_shares where venue_id = $1 and split_id = $2",
      [venueId, split.id],
    )
  ).rows[0]!.n;

  type Row = {
    id: string;
    share_no: number;
    amount_cents: string;
    tax_cents: string;
    gratuity_cents: string;
    state: "open" | "paying" | "paid";
  };
  const cols = "id, share_no, amount_cents, tax_cents, gratuity_cents, state";
  // This guest's share, or the first open one nobody has taken (skipping any another guest holds now).
  let share = (
    await c.query<Row>(
      `select ${cols} from split_shares where venue_id = $1 and split_id = $2 and room_guest_id = $3
        order by share_no limit 1 for update`,
      [venueId, split.id, input.roomGuestId],
    )
  ).rows[0];
  if (!share) {
    share = (
      await c.query<Row>(
        `select ${cols} from split_shares
          where venue_id = $1 and split_id = $2 and room_guest_id is null and state = 'open'
          order by share_no limit 1 for update skip locked`,
        [venueId, split.id],
      )
    ).rows[0];
    if (!share) return null;
    await c.query("update split_shares set room_guest_id = $3 where venue_id = $1 and id = $2", [
      venueId,
      share.id,
      input.roomGuestId,
    ]);
  }
  const base = {
    share_id: share.id,
    share_no: share.share_no,
    shares: shareCount,
    share_cents: Number(share.amount_cents),
    tax_cents: Number(share.tax_cents),
    gratuity_cents: Number(share.gratuity_cents),
  };
  if (share.state === "paid") return { ...base, amount_cents: 0, state: "paid", payment_id: null };
  if (share.state === "paying") {
    // Their page is still open somewhere: the same payment again (its PaymentIntent is reused).
    const p = (
      await c.query<{ payment_id: string; amount_cents: string }>(
        `select a.payment_id, a.amount_cents from payment_allocations a
           join payments p on p.venue_id = a.venue_id and p.id = a.payment_id
          where a.venue_id = $1 and a.share_id = $2 and a.state = 'in_progress' and p.status = 'pending'
          order by a.created_at desc limit 1`,
        [venueId, share.id],
      )
    ).rows[0];
    if (p)
      return {
        ...base,
        amount_cents: Number(p.amount_cents),
        state: "paying",
        payment_id: p.payment_id,
      };
  }
  // Never more than what's still due: if others paid more meanwhile, this share is what's left.
  const amount = Math.min(base.share_cents, await amountDue(c, input.checkId));
  if (amount <= 0) return { ...base, amount_cents: 0, state: "open", payment_id: null };
  const paymentId = await insertPayment(c, venueId, {
    method: "card_online",
    status: "pending",
    businessDate: input.businessDate,
  });
  await allocate(c, venueId, {
    paymentId,
    checkId: input.checkId,
    amountCents: amount,
    state: "in_progress",
    shareId: share.id,
    roomGuestId: input.roomGuestId,
  });
  await c.query("update split_shares set state = 'paying' where venue_id = $1 and id = $2", [
    venueId,
    share.id,
  ]);
  await startAttempt(c, venueId, {
    paymentId,
    checkId: input.checkId,
    portionKey: `share:${share.id}`,
    action: "confirm",
    amountCents: amount,
    startedAt: input.now.toString(),
  });
  return { ...base, amount_cents: amount, state: "paying", payment_id: paymentId };
}
