import { notFound } from "next/navigation";
import { cents, formatMoney, t } from "@west4/shared";

/**
 * The public receipt page (M4-19; screens N2): the same receipt the printer
 * prints and the text and email link to, read from the API by its token. It
 * shows the paid state and, after a refund, the refunded one.
 */
export const dynamic = "force-dynamic";

const api = (process.env["API_URL"] ?? "http://localhost:3000").replace(/\/+$/, "");

interface Line {
  readonly label: string;
  readonly amount_cents: number;
  readonly strong?: boolean;
}
interface Receipt {
  readonly venue: string;
  readonly address: string | null;
  readonly number: string;
  readonly room: string | null;
  readonly opened: string;
  readonly status: string;
  readonly status_label: string;
  readonly lines: readonly Line[];
  readonly totals: readonly Line[];
  readonly payments: readonly Line[];
}

const money = (c: number) =>
  c < 0 ? `−${formatMoney("en", cents(-c))}` : formatMoney("en", cents(c));

function Rows({ lines }: { lines: readonly Line[] }) {
  return (
    <dl>
      {lines.map((l, i) => (
        <div key={i} className={l.strong ? "strong" : undefined}>
          <dt>{l.label}</dt>
          <dd>{money(l.amount_cents)}</dd>
        </div>
      ))}
    </dl>
  );
}

export default async function ReceiptPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const r = await fetch(`${api}/v1/public/receipts/${encodeURIComponent(token)}`, {
    cache: "no-store",
  });
  if (r.status === 404) notFound();
  if (!r.ok) throw new Error(`the receipt couldn't load (${r.status})`);
  const receipt = (await r.json()) as Receipt;
  return (
    <main className="guest receipt-page">
      <header>
        <h1>{receipt.venue}</h1>
        {receipt.address && <p>{receipt.address}</p>}
        <p>{receipt.room ? `${receipt.number} · ${receipt.room}` : receipt.number}</p>
        <p>{receipt.opened}</p>
      </header>
      <section aria-label={t("en", "receiptPage.items")}>
        <Rows lines={receipt.lines} />
      </section>
      <section aria-label={t("en", "receiptPage.totals")}>
        <Rows lines={receipt.totals} />
      </section>
      <section aria-label={t("en", "receiptPage.payments")}>
        <Rows lines={receipt.payments} />
      </section>
      <p className="notice" role="status">
        {receipt.status_label}
      </p>
    </main>
  );
}
