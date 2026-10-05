import { t } from "@west4/shared";
import { SiteFooter, SiteHeader } from "./home";
import { dateWords, hhmmWords, type Availability, type SiteView } from "./data";
import { HoldButton } from "./hold-button";
import { QuoteSummary } from "./quote";

/**
 * Book a room, the Pick step (M5-07; screens Book, N1; Payment flows · the
 * booking page): the date (tonight and later, on the venue's clock), the
 * party size with the billable minimum shown, and the length, then the start
 * times with a free room of the right size and the full price before paying.
 * The fall-back night lists both 1 AMs with EDT and EST. A party too big for
 * the rooms booked online goes to the enquiry form. Server-rendered: the form
 * is a plain GET, so it works with JavaScript off; picking a time holds it.
 */
export function BookPage({
  site,
  base,
  path,
  pick,
}: {
  site: SiteView;
  base: string;
  path: string;
  pick: Availability | null;
}) {
  return (
    <>
      <SiteHeader site={site} base={base} />
      <main className="guest site book-page">
        <h1>{t("en", "site.book.title")}</h1>
        {pick === null ? (
          <p role="status">{t("en", "site.book.off")}</p>
        ) : (
          <Pick site={site} base={base} path={path} pick={pick} />
        )}
      </main>
      <SiteFooter site={site} base={base} />
    </>
  );
}

function Pick({
  site,
  base,
  path,
  pick,
}: {
  site: SiteView;
  base: string;
  path: string;
  pick: Availability;
}) {
  const weekend = [5, 6].includes(new Date(`${pick.business_date}T12:00:00Z`).getUTCDay());
  const hourChoices: number[] = [];
  for (let h = pick.limits.min_hours; h <= Math.min(pick.limits.max_hours, 6); h += 0.5)
    hourChoices.push(h);
  const free = pick.slots.filter((s) => s.free);
  return (
    <>
      <form className="pick" method="get" action={path}>
        <label>
          {t("en", "site.book.date")}
          <input
            type="date"
            name="date"
            min={pick.today}
            defaultValue={pick.business_date}
            required
          />
        </label>
        <label>
          {t("en", "site.book.guests")}
          <input
            type="number"
            name="guests"
            min={1}
            max={500}
            inputMode="numeric"
            defaultValue={pick.guests}
            required
          />
        </label>
        <label>
          {t("en", "site.book.hours")}
          <select name="hours" defaultValue={String(pick.hours)}>
            {hourChoices.map((h) => (
              <option key={h} value={h}>
                {t("en", h === 1 ? "site.book.hourOne" : "site.book.hourMany", { n: h })}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="button secondary">
          {t("en", "site.book.show")}
        </button>
      </form>

      {pick.guests < pick.min_guests && (
        <p className="bill-min" role="note">
          {t("en", weekend ? "site.book.billMinFriSat" : "site.book.billMinWeeknight", {
            n: pick.min_guests,
          })}
        </p>
      )}

      {pick.too_big ? (
        <section aria-labelledby="too-big-h">
          <h2 id="too-big-h">{t("en", "site.book.tooBig", { n: pick.limits.max_guests })}</h2>
          <a className="button" href={`${base}/parties#enquire`}>
            {t("en", "site.parties.plan")}
          </a>
        </section>
      ) : pick.closed ? (
        <p role="status">{t("en", "site.book.closed", { date: dateWords(pick.business_date) })}</p>
      ) : (
        <section aria-labelledby="times-h">
          <h2 id="times-h">
            {t("en", "site.book.times", { date: dateWords(pick.business_date) })}
          </h2>
          {free.length === 0 ? (
            <p role="status">{t("en", "site.book.none")}</p>
          ) : (
            <ul className="slots">
              {pick.slots.map((s) => (
                <li key={s.start}>
                  {s.free ? (
                    <HoldButton
                      slug={site.venue.slug}
                      base={base}
                      date={pick.business_date}
                      time={s.time}
                      zone={s.zone}
                      offset={s.offset}
                      hours={pick.hours}
                      guests={pick.guests}
                      label={hhmmWords(s.time)}
                    />
                  ) : (
                    <span className="slot taken">
                      {hhmmWords(s.time)} <span className="small">{s.zone}</span> ·{" "}
                      {t("en", "site.book.taken")}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {pick.quote && !pick.too_big && (
        <QuoteSummary
          quote={pick.quote}
          hours={pick.hours}
          taxPct={pick.tax_pct}
          gratuityPct={pick.gratuity_pct}
          wording={pick.price_wording}
        />
      )}
    </>
  );
}
