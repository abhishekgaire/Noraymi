import { amountDue, checkById, latestRevision, type Queryable } from "@west4/db";
import { payShareOn } from "../payments/pay-my-share.js";

/**
 * "Your bill" (M4-16; screens N5; Payment flows · Room close-out): what the
 * guests' phones and the booking link show once staff Present the check. The
 * finalized revision's numbers, the lines it was worked from, the deposit,
 * each payment as it lands, and the amount due, read from the same rows the
 * staff screens read, so every screen agrees to the cent.
 */
export interface GuestBill {
  readonly check_id: string;
  readonly number: string;
  readonly revision: number;
  readonly status: "finalized" | "partly_paid" | "paid";
  readonly room_time_cents: number;
  readonly drinks_cents: number;
  readonly other_cents: number;
  readonly lines: readonly { description: string; qty: number; amount_cents: number }[];
  readonly subtotal_cents: number;
  readonly tax_cents: number;
  readonly gratuity_cents: number;
  /** "8.875" and "20": the revision's tax rate and gratuity, as the bill's labels print them. */
  readonly tax_pct: string | null;
  readonly gratuity_pct: string | null;
  readonly total_cents: number;
  readonly deposit_cents: number;
  readonly amount_due_cents: number;
  readonly payments: readonly {
    readonly kind: "card" | "cash" | "online" | "card_on_file" | "share" | "other";
    readonly amount_cents: number;
    readonly brand: string | null;
    readonly last4: string | null;
    readonly name: string | null;
    readonly share_no: number | null;
    readonly shares: number | null;
  }[];
  /** The card that paid the deposit, which the guest may confirm for the rest (M4-17). */
  readonly card_on_file: { readonly brand: string; readonly last4: string } | null;
  /** Staff chose Card on file and it waits for the guest's "Pay with Amex ··1005" (M4-17). */
  readonly on_file_request: { readonly payment_id: string; readonly amount_cents: number } | null;
  /** Pay my share (M4-18), when the venue offers it: into how many shares the bill divides. */
  readonly pay_share: { readonly shares: number } | null;
}

/** "0.08875" → "8.875" (a fraction), "20" → "20" (already a percent): decimal digits moved, never a float. */
function percent(raw: string | null | undefined, fraction = true): string | null {
  if (!raw || !/^\d+(\.\d+)?$/.test(raw)) return null;
  if (!fraction) return raw.replace(/\.0+$/, "");
  const [whole, frac = ""] = raw.split(".");
  const digits = (whole! + frac.padEnd(2, "0")).replace(/^0+(?=\d)/, "");
  const point = digits.length - (frac.length > 2 ? frac.length - 2 : 0);
  const out = frac.length > 2 ? `${digits.slice(0, point)}.${digits.slice(point)}` : digits;
  return out
    .replace(/^\./, "0.")
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
}

const COMPUTED = new Set(["room_time", "min_spend", "tax", "gratuity"]);
const PRESENTED = new Set(["finalized", "partly_paid", "paid"]);

/** The bill, or null while the check is open (not presented yet, or reopened). */
export async function guestBill(
  c: Queryable,
  venueId: string,
  checkId: string,
): Promise<GuestBill | null> {
  const found = await checkById(c, venueId, checkId);
  if (!found || !PRESENTED.has(found.check.status)) return null;
  const rev = await latestRevision(c, venueId, checkId);
  if (!rev) return null;
  const items = found.lines.filter((l) => !COMPUTED.has(l.kind));
  const sum = (ls: readonly { amount_cents: number | string }[]) =>
    ls.reduce((s, l) => s + Number(l.amount_cents), 0);
  const money = await allocationsOn(c, venueId, checkId);
  const deposits = money.rows.filter((m) => m.follows_lines && m.booking_id);
  const paid = money.rows.filter((m) => !(m.follows_lines && m.booking_id));
  const onFile = deposits.find((d) => d.card_brand && d.card_last4);
  const held = Number(
    (
      await c.query<{ held: string }>(
        `select coalesce(sum(amount_cents), 0) as held from payment_allocations
          where venue_id = $1 and check_id = $2 and state = 'in_progress' and not follows_lines`,
        [venueId, checkId],
      )
    ).rows[0]!.held,
  );
  const request = (
    await c.query<{ payment_id: string; amount_cents: string }>(
      `select a.payment_id, a.amount_cents from payment_allocations a
         join payments p on p.venue_id = a.venue_id and p.id = a.payment_id
        where a.venue_id = $1 and a.check_id = $2 and a.state = 'in_progress'
          and p.method = 'card_on_file' and p.status = 'pending'
          and not exists (select 1 from payment_attempts t where t.venue_id = p.venue_id and t.payment_id = p.id)
        order by a.created_at desc limit 1`,
      [venueId, checkId],
    )
  ).rows[0];
  // Pay my share (M4-18): the open split's share count, or the party size it would start at.
  const shareOn = await payShareOn(c, venueId, found.check.business_date);
  const shares = shareOn
    ? (
        await c.query<{ n: number }>(
          `select coalesce(
             (select nullif(count(*)::int, 0) from split_shares x join check_splits k on k.venue_id = x.venue_id and k.id = x.split_id
               where k.venue_id = $1 and k.check_id = $2 and k.ended_at is null),
             (select greatest(2, s.party_size) from room_sessions s join checks c2 on c2.venue_id = s.venue_id and c2.room_session_id = s.id
               where c2.venue_id = $1 and c2.id = $2),
             2) as n`,
          [venueId, checkId],
        )
      ).rows[0]!.n
    : 0;
  return {
    check_id: checkId,
    number: String(found.check.number),
    revision: rev.rev,
    status: found.check.status as GuestBill["status"],
    room_time_cents: sum(
      found.lines.filter((l) => l.kind === "room_time" || l.kind === "min_spend"),
    ),
    drinks_cents: sum(items.filter((l) => l.tax_category === "drink")),
    other_cents: sum(items.filter((l) => l.tax_category !== "drink")),
    lines: items.map((l) => ({
      description: l.description,
      qty: Number(l.qty),
      amount_cents: Number(l.amount_cents),
    })),
    subtotal_cents: Number(rev.subtotal_cents),
    tax_cents: Number(rev.tax_cents),
    gratuity_cents: Number(rev.gratuity_cents),
    tax_pct: percent(found.lines.find((l) => l.kind === "tax" && l.revision === rev.rev)?.tax_rate),
    gratuity_pct: percent(
      rev.gratuity_basis?.["pct"] === undefined ? null : String(rev.gratuity_basis["pct"]),
      false,
    ),
    total_cents: Number(rev.total_cents),
    deposit_cents: sum(deposits),
    // What's left to pay, counting only money that landed: an amount held while a guest confirms
    // (card on file) or a payment page is open still shows as due.
    amount_due_cents: (await amountDue(c, checkId)) + held,
    payments: paid.map(paymentLine),
    card_on_file: onFile ? { brand: onFile.card_brand!, last4: onFile.card_last4! } : null,
    pay_share: shareOn ? { shares } : null,
    on_file_request: request
      ? { payment_id: request.payment_id, amount_cents: Number(request.amount_cents) }
      : null,
  };
}

/** The room a check's session is in, so its events reach the room's phones (M4-16). */
export async function roomOfCheck(
  c: Queryable,
  venueId: string,
  checkId: string,
): Promise<string | undefined> {
  const r = await c.query<{ room_id: string }>(
    `select s.room_id from checks k join room_sessions s on s.venue_id = k.venue_id and s.id = k.room_session_id
      where k.venue_id = $1 and k.id = $2`,
    [venueId, checkId],
  );
  return r.rows[0]?.room_id;
}

type AllocationRow = {
  method: string;
  amount_cents: string;
  follows_lines: boolean;
  booking_id: string | null;
  card_brand: string | null;
  card_last4: string | null;
  name: string | null;
  share_no: number | null;
  shares: number | null;
};

/** The captured payments on a check, with the guest and share each names (M4-16, M4-18). */
async function allocationsOn(c: Queryable, venueId: string, checkId: string) {
  return c.query<{
    method: string;
    amount_cents: string;
    follows_lines: boolean;
    booking_id: string | null;
    card_brand: string | null;
    card_last4: string | null;
    name: string | null;
    share_no: number | null;
    shares: number | null;
  }>(
    `select p.method, a.amount_cents, a.follows_lines, p.booking_id, p.card_brand, p.card_last4,
            g.name, s.share_no,
            (select count(*)::int from split_shares x where x.venue_id = s.venue_id and x.split_id = s.split_id) as shares
       from payment_allocations a
       join payments p on p.venue_id = a.venue_id and p.id = a.payment_id
       left join split_shares s on s.venue_id = a.venue_id and s.id = a.share_id
       left join room_guests g on g.venue_id = a.venue_id and g.id = coalesce(a.room_guest_id, s.room_guest_id)
      where a.venue_id = $1 and a.check_id = $2 and a.state = 'captured' and a.kind = 'payment'
      order by a.created_at, a.id`,
    [venueId, checkId],
  );
}

function paymentLine(m: AllocationRow): GuestBill["payments"][number] {
  return {
    kind:
      m.share_no !== null
        ? "share"
        : m.method === "card_present"
          ? "card"
          : m.method === "cash"
            ? "cash"
            : m.method === "card_online"
              ? "online"
              : m.method === "card_on_file"
                ? "card_on_file"
                : "other",
    amount_cents: Number(m.amount_cents),
    brand: m.card_brand,
    last4: m.card_last4,
    name: m.name,
    share_no: m.share_no,
    shares: m.shares,
  };
}

/** The payments on a check as the room tab lists them ("Paid by a guest · Kevin (share 1 of 12) $41.55"). */
export async function checkPayments(
  c: Queryable,
  venueId: string,
  checkId: string,
): Promise<GuestBill["payments"]> {
  const rows = (await allocationsOn(c, venueId, checkId)).rows;
  return rows.filter((m) => !(m.follows_lines && m.booking_id)).map(paymentLine);
}
