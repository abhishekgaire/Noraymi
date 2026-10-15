import { useEffect, useRef, useState } from "react";
import { cashOffers, changeDue, offlineCashSalePrice, type TaxCategory } from "@west4/rules";
import { cents } from "@west4/shared";
import { useT } from "../i18n.js";
import { newOrderId, useQueue, type OfflineCashTermsView, type QueuedCashSale } from "../queue.js";
import { useKeptTeam, type QueueLineSource } from "./QueuePanel.js";

/**
 * A cash quick sale in queue mode (U-16; D133; spec 09 · Cash quick sales while offline). Only while
 * the venue's "Take cash quick sales while offline" is on, which the bar computer knows from the terms
 * it kept with GET /pos/terminal. Drinks tapped on the grid (the alcohol window and 86'd drinks are
 * greyed from the kept menu, as online), priced with packages/rules as the replay will price them, the
 * cash price with the cash discount on (U-02). One tap on what the guest handed over keeps the sale on
 * this computer and opens its drawer; the sale replays once when the connection returns.
 */
export interface CashLineSource extends QueueLineSource {
  readonly tax_category: string | null;
}

type Line = CashLineSource & { readonly qty: number };

export function priceOf(lines: readonly Line[], terms: OfflineCashTermsView) {
  return offlineCashSalePrice(
    lines.map((l) => ({
      qty: l.qty,
      unitCents: l.unit_cents,
      taxCategory: l.tax_category as TaxCategory | null,
    })),
    {
      tax: {
        rate: terms.tax.rate,
        taxedCategories: terms.tax.taxed_categories as TaxCategory[],
        surchargeTaxable: terms.tax.surcharge_taxable,
        jurisdictionCode: terms.tax.jurisdiction_code,
      },
      gratuityPct: terms.gratuity_pct,
      cashDiscount: terms.cash_discount && {
        pct: terms.cash_discount.pct,
        taxRatePct: terms.cash_discount.tax_rate_pct,
        foodIncludesFee: terms.cash_discount.food_includes_fee,
      },
    },
  );
}

const linesText = (lines: readonly { qty: number; name: string }[]) =>
  lines.map((l) => `${l.qty} × ${l.name}`).join(", ");

export function OfflineCashSale({
  venueId,
  terms,
  ringRequest,
  lookup,
  alcoholClosed,
}: {
  venueId: string;
  terms: OfflineCashTermsView;
  ringRequest: { variantId: string; n: number } | null;
  lookup: (variantId: string) => CashLineSource | null;
  /** The alcohol window as the kept menu says it now: closed refuses an alcohol line, as online. */
  alcoholClosed: boolean;
}) {
  const { t, money } = useT();
  const queue = useQueue();
  const team = useKeptTeam(venueId);
  const [lines, setLines] = useState<readonly Line[]>([]);
  const [who, setWho] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ change: number; kicked: boolean } | null>(null);
  const seen = useRef(ringRequest?.n ?? 0);

  // A tap on the grid adds the drink; the first tap after a kept sale starts the next one.
  useEffect(() => {
    if (!ringRequest || ringRequest.n === seen.current) return;
    seen.current = ringRequest.n;
    const found = lookup(ringRequest.variantId);
    if (!found) return;
    setDone(null);
    setError(null);
    setLines((ls) => {
      const i = ls.findIndex((l) => l.variant_id === found.variant_id);
      if (i < 0) return [...ls, { ...found, qty: 1 }];
      return ls.map((l, j) => (j === i ? { ...l, qty: Math.min(99, l.qty + 1) } : l));
    });
  }, [ringRequest, lookup]);

  const price = lines.length > 0 ? priceOf(lines, terms) : null;
  const person = team.find((p) => p.membership_id === who);
  const refused = alcoholClosed && lines.some((l) => l.alcohol);

  const take = async (tendered: number) => {
    if (!price || !person || refused || busy) return;
    setBusy(true);
    setError(null);
    try {
      const sale: Omit<QueuedCashSale, "business_date" | "queued_at"> = {
        kind: "cash_sale",
        order_id: newOrderId(),
        staff: { membership_id: person.membership_id, name: person.name },
        lines: lines.map((l) => ({
          variant_id: l.variant_id,
          name: l.name,
          qty: l.qty,
          unit_cents: l.unit_cents,
          alcohol: l.alcohol,
        })),
        total_cents: price.totalCents,
        cash_cents: price.cashCents,
        tendered_cents: tendered,
      };
      const r = await queue.addSale(sale);
      setDone({
        change: changeDue({ owedCents: price.cashCents, tenderedCents: tendered }) ?? 0,
        kicked: r.kicked,
      });
      setLines([]);
    } catch {
      setError(t("offlineCash.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="queue-panel offline-cash" data-queue aria-label={t("offlineCash.title")}>
      <h3>{t("offlineCash.title")}</h3>
      <p className="small muted">{t("offlineCash.hint")}</p>
      {done && (
        <div className="cash" role="status" data-testid="offline-cash-kept">
          <p className="change-due">
            {t("cash.change")} <strong>{money(cents(done.change))}</strong>
          </p>
          <p className="small">{t("offlineCash.kept")}</p>
          {!done.kicked && <p className="notice">{t("offlineCash.noKick")}</p>}
        </div>
      )}
      {lines.length === 0 ? (
        !done && <p className="small muted">{t("queue.round.empty")}</p>
      ) : (
        <ul className="queue-lines">
          {lines.map((l) => (
            <li key={l.variant_id}>
              <span data-guest-text>
                {l.qty} × {l.name}
              </span>{" "}
              <button
                type="button"
                className="link"
                aria-label={t("queue.round.remove", { name: l.name })}
                onClick={() => setLines((ls) => ls.filter((x) => x.variant_id !== l.variant_id))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {price && (
        <p className="total" data-testid="offline-cash-total">
          {t("offlineCash.total", { amount: money(cents(price.cashCents)) })}
          {price.cashCents !== price.totalCents && (
            <span className="small muted">
              {" "}
              {t("cash.bothPrices", {
                card: money(cents(price.totalCents)),
                cash: money(cents(price.cashCents)),
              })}
            </span>
          )}
        </p>
      )}
      {refused && (
        <p className="error" role="alert">
          {t("drinks.alcohol.closed")}
        </p>
      )}
      <label>
        {t("queue.round.who")}
        <select value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">{t("queue.round.pickWho")}</option>
          {team.map((p) => (
            <option key={p.membership_id} value={p.membership_id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {price && (
        <div className="team-actions" role="group" aria-label={t("cash.handedOver")}>
          {cashOffers(price.cashCents).map((o) => (
            <button
              key={o.kind}
              type="button"
              className={o.kind === "exact" ? "primary" : "secondary"}
              disabled={!person || refused || busy}
              onClick={() => void take(o.cents)}
            >
              {o.kind === "exact" ? t("cash.exact", { amount: money(o.cents) }) : money(o.cents)}
            </button>
          ))}
        </div>
      )}
      {!person && lines.length > 0 && <p className="small muted">{t("offlineCash.pickWho")}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {queue.sales.length > 0 && (
        <ul className="queued-rounds" aria-label={t("offlineCash.list")}>
          {queue.sales.map((s) => (
            <li key={s.order_id} className="queued">
              {t("offlineCash.listLine", {
                lines: linesText(s.lines),
                amount: money(cents(s.cash_cents)),
                name: s.staff.name,
              })}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
