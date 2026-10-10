import { checkById, depositsOn, latestRevision, type Queryable } from "@west4/db";
import { Temporal, cents, formatMoney, t, trainingNumber, type MessageKey } from "@west4/shared";
import { checkPayments } from "../rooms/guest-bill.js";

/**
 * The receipt (M4-19; Money rules 8, 9 and 10; Payment flows · Room close-out
 * steps 3 and 4; screens N2): one model built from the check's latest revision
 * and its payments, whose labelled lines every render reads, printed, texted,
 * emailed and on the web, so the four read the same. Comps and voids show as
 * COMP and VOID, tax by category, "Gratuity included (20%)", "Deposit
 * −$120.00", each payment, any "Additional tip (optional)", and the check
 * number. Times are New York time with EDT or EST.
 */
export interface ReceiptLine {
  readonly label: string;
  readonly amount_cents: number;
  /** Totals and the amount due stand out. */
  readonly strong?: boolean;
}
export type ReceiptStatus = "paid" | "partly_paid" | "open" | "refunded" | "partly_refunded";

export interface ReceiptModel {
  readonly venue: string;
  readonly address: string | null;
  readonly number: string;
  /** A practice check (training mode, M7-03): the receipt says TRAINING. */
  readonly training: boolean;
  readonly room: string | null;
  readonly opened: string;
  readonly paid: string | null;
  readonly status: ReceiptStatus;
  readonly status_label: string;
  readonly lines: readonly ReceiptLine[];
  readonly totals: readonly ReceiptLine[];
  readonly payments: readonly ReceiptLine[];
  readonly total_cents: number;
  readonly amount_due_cents: number;
  readonly refunded_cents: number;
}

const COMPUTED = new Set(["room_time", "min_spend", "tax", "gratuity"]);
const BRANDS: Record<string, string> = {
  amex: "Amex",
  visa: "Visa",
  mastercard: "Mastercard",
  discover: "Discover",
};
const money = (c: number) =>
  c < 0 ? `−${formatMoney("en", cents(-c))}` : formatMoney("en", cents(c));

/** "Fri Sep 25, 2026 · 10:41 PM EDT", in the venue's zone. */
export function receiptTime(iso: string, timeZone: string): string {
  const d = new Date(Temporal.Instant.from(iso).epochMilliseconds);
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(d);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(d);
  return `${day.replace(",", "")} · ${time}`;
}

/** "0.08875" → "8.875": decimal digits moved, never a float. */
function percentOf(rate: string | null): string {
  if (!rate || !/^\d+(\.\d+)?$/.test(rate)) return "";
  const [whole, frac = ""] = rate.split(".");
  const digits = (whole! + frac.padEnd(2, "0")).replace(/^0+(?=\d)/, "");
  const point = digits.length - Math.max(0, frac.length - 2);
  const out = frac.length > 2 ? `${digits.slice(0, point)}.${digits.slice(point)}` : digits;
  return out.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

/** A tax line's category, from the words finalize wrote ("Tax · room time"; apps/api/src/rooms/finalize.ts). */
const TAX_FROM_WORDS: Record<string, string> = {
  "room time": "room_time",
  drinks: "drink",
  food: "food",
  songs: "song",
  damage: "damage",
  fees: "fee",
};
function taxCategoryOf(description: string): string {
  return TAX_FROM_WORDS[description.replace(/^Tax · /, "")] ?? "other";
}

export async function receiptModel(
  c: Queryable,
  venueId: string,
  checkId: string,
): Promise<ReceiptModel | null> {
  const found = await checkById(c, venueId, checkId);
  if (!found) return null;
  const rev = await latestRevision(c, venueId, checkId);
  const v = (
    await c.query<{
      name: string;
      address: Record<string, string> | null;
      time_zone: string;
      opened_at: string;
      paid_at: string | null;
      room: string | null;
    }>(
      `select v.name, v.address, v.time_zone, to_json(k.opened_at) #>> '{}' as opened_at,
              to_json(k.paid_at) #>> '{}' as paid_at, r.name as room
         from checks k join venues v on v.id = k.venue_id
         left join room_sessions s on s.venue_id = k.venue_id and s.id = k.room_session_id
         left join rooms r on r.venue_id = s.venue_id and r.id = s.room_id
        where k.venue_id = $1 and k.id = $2`,
      [venueId, checkId],
    )
  ).rows[0]!;

  // The standing lines: a line reversed by a later one, and the reversal, both drop out for computed
  // lines (a new revision rewrites them); comps and voids stay, as COMP and VOID.
  const reversed = new Set(found.lines.map((l) => l.reverses_id).filter((x) => x !== null));
  const standing = found.lines.filter(
    (l) => !COMPUTED.has(l.kind) || (l.reverses_id === null && !reversed.has(l.id)),
  );
  const segments =
    (rev?.billing_basis?.["segments"] as { hourly_cents: number }[] | undefined) ?? [];
  const rates = [...new Set(segments.map((s) => s.hourly_cents))].map((h) => money(h)).join(" → ");
  const minutes = Number(rev?.billing_basis?.["minutes"] ?? 0);
  const lines: ReceiptLine[] = [];
  // A package's lines carry its name (K-09; spec 16 · Food in packages): "Party pack · Wings".
  const packageOf = new Map(
    (
      await c.query<{ id: string; name: string }>(
        `select l.id, p.name from check_lines l
           join order_items oi on oi.venue_id = l.venue_id and oi.id = l.source_id
           join packages p on p.venue_id = oi.venue_id and p.id = oi.package_id
          where l.venue_id = $1 and l.check_id = $2 and l.kind = 'item'`,
        [venueId, checkId],
      )
    ).rows.map((r) => [Number(r.id), r.name]),
  );
  // Room time first, then everything else in the order it was added.
  const ordered = [
    ...standing.filter((l) => l.kind === "room_time" || l.kind === "min_spend"),
    ...standing.filter((l) => l.kind !== "room_time" && l.kind !== "min_spend"),
  ];
  for (const l of ordered) {
    if (l.kind === "tax" || l.kind === "gratuity") continue;
    const qty = Number(l.qty) > 1 ? `${l.qty} × ` : "";
    const label =
      l.kind === "room_time"
        ? rates
          ? t("en", "receipt.roomTime", { min: minutes, rate: rates })
          : t("en", "receipt.roomTimeOnly", { min: minutes })
        : l.kind === "comp"
          ? t("en", "receipt.comp", { item: l.description })
          : l.kind === "void"
            ? t("en", "receipt.void", { item: l.description })
            : l.kind === "card_surcharge"
              ? t("en", "receipt.surcharge")
              : packageOf.has(Number(l.id))
                ? `${qty}${packageOf.get(Number(l.id))} · ${l.description}`
                : `${qty}${l.description}`;
    lines.push({ label, amount_cents: Number(l.amount_cents) });
  }
  const totals: ReceiptLine[] = [];
  const subtotal = rev ? Number(rev.subtotal_cents) : lines.reduce((s, l) => s + l.amount_cents, 0);
  totals.push({ label: t("en", "receipt.subtotal"), amount_cents: subtotal });
  for (const l of standing.filter((x) => x.kind === "tax"))
    totals.push({
      label: t("en", "receipt.tax", {
        what: t("en", `receipt.taxOn.${taxCategoryOf(l.description)}` as MessageKey),
        pct: percentOf(l.tax_rate),
      }),
      amount_cents: Number(l.amount_cents),
    });
  const gratuity = standing.filter((x) => x.kind === "gratuity");
  const gratuityPct = rev?.gratuity_basis?.["pct"];
  if (gratuity.length > 0)
    totals.push({
      label: t("en", "receipt.gratuity", { pct: String(gratuityPct ?? "") }),
      amount_cents: gratuity.reduce((s, l) => s + Number(l.amount_cents), 0),
    });
  const total = rev
    ? Number(rev.total_cents)
    : standing.reduce((s, l) => s + Number(l.amount_cents), 0);
  totals.push({ label: t("en", "receipt.total"), amount_cents: total, strong: true });

  // What paid it: the deposit first, then each payment as the room tab lists it, then any tip.
  const deposit = (await depositsOn(c, venueId, checkId)).reduce((s, d) => s + d.amount_cents, 0);
  const payments: ReceiptLine[] = [];
  if (deposit > 0) payments.push({ label: t("en", "receipt.deposit"), amount_cents: -deposit });
  const card = await c.query<{ id: string; tip_cents: string }>(
    `select distinct p.id, p.tip_cents
       from payments p join payment_allocations a on a.venue_id = p.venue_id and a.payment_id = p.id
      where p.venue_id = $1 and a.check_id = $2 and a.state = 'captured'`,
    [venueId, checkId],
  );
  for (const p of await checkPayments(c, venueId, checkId)) {
    const label =
      p.kind === "share" && p.share_no !== null
        ? t("en", "yourBill.paidBy.share", {
            name: p.name ?? "",
            n: p.share_no,
            of: p.shares ?? p.share_no,
          })
        : (p.kind === "card" || p.kind === "card_on_file" || p.kind === "online") && p.last4
          ? t("en", "receipt.card", {
              brand: BRANDS[p.brand ?? ""] ?? p.brand ?? "",
              last4: p.last4,
            })
          : p.kind === "cash"
            ? t("en", "yourBill.paidBy.cash")
            : t("en", "yourBill.paidBy.other");
    payments.push({ label, amount_cents: -p.amount_cents });
  }
  const tip = card.rows.reduce((s, p) => s + Number(p.tip_cents), 0);
  if (tip > 0) payments.push({ label: t("en", "receipt.tip"), amount_cents: tip });

  const refunded = -Number(
    (
      await c.query<{ r: string }>(
        `select coalesce(sum(amount_cents), 0) as r from payment_allocations
          where venue_id = $1 and check_id = $2 and kind = 'refund' and state = 'captured'`,
        [venueId, checkId],
      )
    ).rows[0]!.r,
  );
  if (refunded > 0) payments.push({ label: t("en", "receipt.refund"), amount_cents: refunded });
  // Left to pay, counting only money that landed (a payment page left open still shows as due).
  const due = Number(
    (
      await c.query<{ d: string }>(
        `select amount_due($2) + coalesce((select sum(amount_cents) from payment_allocations
            where venue_id = $1 and check_id = $2 and state = 'in_progress' and not follows_lines), 0) as d`,
        [venueId, checkId],
      )
    ).rows[0]!.d,
  );
  payments.push({ label: t("en", "receipt.due"), amount_cents: due, strong: true });

  const paidCents = total - due;
  const status: ReceiptStatus =
    refunded > 0 && refunded >= paidCents
      ? "refunded"
      : refunded > 0
        ? "partly_refunded"
        : found.check.status === "paid"
          ? "paid"
          : found.check.status === "partly_paid"
            ? "partly_paid"
            : "open";
  return {
    venue: v.name,
    address: v.address ? [v.address["line1"], v.address["city"]].filter(Boolean).join(", ") : null,
    number: found.check.training
      ? t("en", "receipt.numberTraining", { number: trainingNumber(found.check.number) })
      : t("en", "receipt.number", { number: String(found.check.number) }),
    training: found.check.training,
    room: v.room,
    opened: receiptTime(v.opened_at, v.time_zone),
    paid: v.paid_at ? receiptTime(v.paid_at, v.time_zone) : null,
    status,
    status_label: t("en", `receipt.status.${status}` as MessageKey, {
      amount: money(refunded),
    }),
    lines,
    totals,
    payments,
    total_cents: total,
    amount_due_cents: due,
    refunded_cents: refunded,
  };
}

/** The plain-text receipt, one line per entry: what the printer prints, and what every render must say. */
export function receiptText(m: ReceiptModel): string[] {
  const row = (l: ReceiptLine) => `${l.label}  ${money(l.amount_cents)}`;
  return [
    ...(m.training ? [t("en", "training.band")] : []),
    m.venue,
    ...(m.address ? [m.address] : []),
    m.room ? `${m.number} · ${m.room}` : m.number,
    m.opened,
    ...m.lines.map(row),
    ...m.totals.map(row),
    ...m.payments.map(row),
    m.status_label,
  ];
}
