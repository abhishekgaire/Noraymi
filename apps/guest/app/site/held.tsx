import { cents, formatMoney, t, type MessageKey } from "@west4/shared";
import { SiteFooter, SiteHeader } from "./home";
import { clockWords, dateWords, type HeldBooking, type SiteView } from "./data";
import { Countdown } from "./countdown";
import { QuoteSummary } from "./quote";
import { DetailsForm } from "./details-form";
import { PayButton } from "./pay-button";

/** The Terms step (M5-08): the deposit policy now in force, this booking's cut-off and the gratuity sentence. */
export function Terms({ held, token }: { held: HeldBooking; token: string }) {
  if (!held.policy) return null;
  return (
    <section aria-labelledby="terms-h" className="terms">
      <h2 id="terms-h">{t("en", "site.book.terms")}</h2>
      {held.cutoff_words && (
        <p className="cutoff">{t("en", "site.book.cutoff", { cutoff: held.cutoff_words })}</p>
      )}
      {held.policy.text
        .split("\n")
        .filter((line) => line.trim())
        .map((line, i) => (
          <p key={i}>{line}</p>
        ))}
      <p className="small">{t("en", "site.book.policyVersion", { n: held.policy.version })}</p>
      {held.quote.deposit_cents > 0 && (
        <PayButton
          token={token}
          label={t("en", "payPage.payDeposit", {
            amount: formatMoney("en", cents(held.quote.deposit_cents)),
          })}
        />
      )}
    </section>
  );
}

/**
 * The held booking (M5-07): the room size held, the date, time and length,
 * the full price and the deposit, and the hold's countdown with More time.
 * A hold that ran out says so and sends the guest back to pick a time. The
 * guest's details and the terms (M5-08) follow, then the payment page (M5-09).
 */
export function HeldPage({
  site,
  base,
  token,
  held,
}: {
  site: SiteView;
  base: string;
  token: string;
  held: HeldBooking;
}) {
  const hours = held.quote.minutes / 60;
  const tier = t("en", `site.book.tier.${held.size_tier}` as MessageKey);
  const lapsed = held.status === "lapsed" || held.status === "cancelled";
  return (
    <>
      <SiteHeader site={site} base={base} />
      <main className="guest site book-page">
        {lapsed ? (
          <section aria-labelledby="lapsed-h">
            <h1 id="lapsed-h">{t("en", "site.book.lapsed")}</h1>
            <a className="button" href={`${base}/book`}>
              {t("en", "site.book.pickAgain")}
            </a>
          </section>
        ) : (
          <>
            <h1>
              {t("en", "site.book.held", {
                tier: tier.startsWith("site.") ? held.size_tier : tier,
              })}
            </h1>
            <p className="lead">
              {t("en", hours === 1 ? "site.book.whenOne" : "site.book.when", {
                date: dateWords(held.quote.business_date),
                time: clockWords(held.starts_at, held.time_zone),
                guests: held.party_size,
                n: hours,
              })}
            </p>
            {held.status === "pending" && held.seconds_left !== null && (
              <Countdown
                token={token}
                secondsLeft={held.seconds_left}
                moreTimeLeft={held.more_time_left}
              />
            )}
            <QuoteSummary
              quote={held.quote}
              hours={hours}
              taxPct={held.tax_pct}
              gratuityPct={held.gratuity_pct}
              wording={held.price_wording}
            />
            {held.status === "pending" && (
              <>
                <DetailsForm token={token} initial={held.guest} marketingBox={held.marketing_box} />
                {held.guest && <Terms held={held} token={token} />}
              </>
            )}
          </>
        )}
      </main>
      <SiteFooter site={site} base={base} />
    </>
  );
}
