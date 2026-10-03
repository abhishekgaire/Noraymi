import { t, type MessageKey } from "@west4/shared";
import { BookButton, SiteFooter, SiteHeader } from "./home";
import { money, phoneLabel, type SiteView } from "./data";

/**
 * Private parties (M5-01; screens Parties): what the venue hosts, its room
 * sizes, a rough cost estimator (room time for a head count and hours, with tax
 * and the gratuity), drink packages from the menu, and the enquiry form, which
 * M5-04 adds (until then, the call line). Server-rendered; the estimator's −
 * and + are links, so it works with JavaScript off.
 */
export function Parties({ site, base, path }: { site: SiteView; base: string; path: string }) {
  const c = site.content.parties;
  const r = site.rooms;
  const e = site.estimate;
  const max = Math.max(...r.tiers.map((x) => x.capacityMax), 1);
  const link = (guests: number, hours: number) =>
    `${path}?guests=${guests}&hours=${hours}#estimate`;
  const tierPrice = (tier: { vip: boolean; capacityMin: number }) =>
    tier.vip && site.prices.vip
      ? t("en", "site.rooms.cost", { amount: money(site.prices.vip.hourly_cents) })
      : site.prices.per_person_cents !== null
        ? t(
            "en",
            site.prices.wording === "allIn" ? "site.price.perPersonAllIn" : "site.price.perPerson",
            {
              amount: money(site.prices.per_person_cents),
              pct: site.prices.gratuity_pct,
            },
          )
        : "";
  return (
    <>
      <SiteHeader site={site} base={base} />
      <main className="guest site parties">
        <section className="hero" aria-labelledby="parties-h">
          <p className="kicker">{t("en", "site.nav.parties")}</p>
          <h1 id="parties-h">{c.headline}</h1>
          <p className="lead">{c.lead}</p>
          <a className="button" href="#enquire">
            {t("en", "site.parties.plan")}
          </a>
          {site.phone && (
            <a className="button secondary" href={`tel:${site.phone}`}>
              {t("en", "site.parties.call", { phone: phoneLabel(site.phone) })}
            </a>
          )}
        </section>

        <section aria-labelledby="hosts-h">
          <h2 id="hosts-h">{t("en", "site.parties.hosts")}</h2>
          <ul className="hosts">
            {c.hosts.map((h) => (
              <li key={h.title}>
                <h3>{h.title}</h3>
                <p className="kicker">{h.tag}</p>
                <p>{h.text}</p>
              </li>
            ))}
          </ul>
        </section>

        {site.modules.rooms && (
          <section aria-labelledby="party-rooms-h">
            <h2 id="party-rooms-h">{t("en", "site.rooms")}</h2>
            <ul className="tiers">
              {r.tiers.map((tier) => (
                <li key={tier.tier}>
                  <h3>{t("en", `site.tier.${tier.tier}` as MessageKey)}</h3>
                  <p>{t("en", "site.parties.roomCount", { n: tier.rooms })}</p>
                  <p>
                    {t("en", "site.parties.fits", { min: tier.capacityMin, max: tier.capacityMax })}
                  </p>
                  <p>{tierPrice(tier)}</p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {e && (
          <section id="estimate" aria-labelledby="estimate-h">
            <h2 id="estimate-h">{t("en", "site.parties.estimate")}</h2>
            <div className="picker">
              <a
                className="button secondary"
                href={link(Math.max(1, r.guests - 1), e.hours)}
                aria-label={t("en", "site.rooms.fewer")}
              >
                −
              </a>
              <output>{t("en", "site.parties.guests", { n: r.guests })}</output>
              <a
                className="button secondary"
                href={link(Math.min(max, r.guests + 1), e.hours)}
                aria-label={t("en", "site.rooms.more")}
              >
                +
              </a>
            </div>
            <div className="picker">
              <a
                className="button secondary"
                href={link(r.guests, Math.max(1, e.hours - 1))}
                aria-label={t("en", "site.parties.oneHour")}
              >
                −
              </a>
              <output>
                {e.hours === 1
                  ? t("en", "site.parties.oneHour")
                  : t("en", "site.parties.hours", { n: e.hours })}
              </output>
              <a
                className="button secondary"
                href={link(r.guests, Math.min(8, e.hours + 1))}
                aria-label={t("en", "site.parties.hours", { n: e.hours + 1 })}
              >
                +
              </a>
            </div>
            <dl className="estimate" aria-live="polite">
              <dt>{t("en", "site.parties.roomTime")}</dt>
              <dd>{money(e.room_time_cents)}</dd>
              <dt>{t("en", "site.parties.tax", { pct: site.tax_pct })}</dt>
              <dd>{money(e.tax_cents)}</dd>
              <dt>{t("en", "site.parties.gratuity", { pct: site.prices.gratuity_pct })}</dt>
              <dd>{money(e.gratuity_cents)}</dd>
              <dt>
                <strong>{t("en", "site.parties.total")}</strong>
              </dt>
              <dd>
                <strong>{money(e.total_cents)}</strong>
              </dd>
            </dl>
            <p className="hint">{t("en", "site.parties.estimateNote")}</p>
          </section>
        )}

        <section aria-labelledby="notes-h">
          <h2 id="notes-h">{t("en", "site.parties.notes")}</h2>
          <ol>
            {c.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ol>
        </section>

        {site.modules.packages && site.packages.length > 0 && (
          <section aria-labelledby="packages-h">
            <h2 id="packages-h">{t("en", "site.parties.packages")}</h2>
            <ul className="packages">
              {site.packages.map((p) => (
                <li key={p.name}>
                  {p.name} ·{" "}
                  {p.hourly
                    ? t("en", "site.parties.packageHourly", { amount: money(p.price_cents) })
                    : money(p.price_cents)}
                </li>
              ))}
            </ul>
            {c.packagesNote && <p className="hint">{c.packagesNote}</p>}
          </section>
        )}

        <section id="enquire" aria-labelledby="enquire-h">
          <h2 id="enquire-h">{t("en", "site.parties.enquire")}</h2>
          {site.phone && (
            <p>{t("en", "site.parties.enquireCall", { phone: phoneLabel(site.phone) })}</p>
          )}
          <BookButton site={site} base={base} />
        </section>
      </main>
      <SiteFooter site={site} base={base} />
    </>
  );
}
