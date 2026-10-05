import { t } from "@west4/shared";
import { money, type Quote } from "./data";

/**
 * The full price before paying (M5-07; Payment flows · the booking page):
 * room time for the booked length at the billable guests, tax, the gratuity
 * and the total, then the deposit that holds it, worded the venue's way
 * (website.priceWording).
 */
export function QuoteSummary({
  quote,
  hours,
  taxPct,
  gratuityPct,
  wording,
}: {
  quote: Quote;
  hours: number;
  taxPct: string;
  gratuityPct: number;
  wording: "plusTaxAndGratuity" | "allIn";
}) {
  return (
    <section className="quote" aria-labelledby="quote-h">
      <h2 id="quote-h">{t("en", "site.book.summary")}</h2>
      <dl>
        {wording === "plusTaxAndGratuity" ? (
          <>
            <div>
              <dt>
                {t("en", hours === 1 ? "site.book.roomTimeOne" : "site.book.roomTime", {
                  n: hours,
                  guests: quote.billable_guests,
                })}
              </dt>
              <dd>{money(quote.room_time_cents)}</dd>
            </div>
            <div>
              <dt>{t("en", "site.book.tax", { pct: taxPct })}</dt>
              <dd>{money(quote.tax_cents)}</dd>
            </div>
            {gratuityPct > 0 && (
              <div>
                <dt>{t("en", "site.book.gratuity", { pct: gratuityPct })}</dt>
                <dd>{money(quote.gratuity_cents)}</dd>
              </div>
            )}
            <div className="total">
              <dt>{t("en", "site.book.total")}</dt>
              <dd>{money(quote.total_cents)}</dd>
            </div>
          </>
        ) : (
          <div className="total">
            <dt>{t("en", "site.book.totalAllIn")}</dt>
            <dd>{money(quote.total_cents)}</dd>
          </div>
        )}
        {quote.deposit_cents > 0 && (
          <div className="deposit">
            <dt>{t("en", "site.book.deposit")}</dt>
            <dd>{money(quote.deposit_cents)}</dd>
          </div>
        )}
      </dl>
      {quote.deposit_cents > 0 && <p className="small">{t("en", "site.book.depositNote")}</p>}
    </section>
  );
}
