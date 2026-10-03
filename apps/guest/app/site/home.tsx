import { Fragment } from "react";
import { t, type MessageKey } from "@west4/shared";
import { clockWords, hhmmWords, money, phoneLabel, type SiteView } from "./data";

/**
 * The venue's home page (M5-01; screens Main and Rooms): the hero, the
 * numbers, the songbook, "Sing at the bar" (behind its flag), the bar's
 * prices, house rules, the rooms and their picker, hours and address. Every
 * live fact comes from the API; the words from the published site version;
 * sections follow the modules. Server-rendered, so it reads with JavaScript off.
 */
export function openLine(site: SiteView): string {
  const tz = site.venue.time_zone;
  if (site.hours.closed_tonight) return t("en", "site.open.closedTonight");
  if (site.hours.open_now && site.hours.closes)
    return t("en", "site.open.now", { time: clockWords(site.hours.closes, tz) });
  if (site.hours.opens && Date.parse(site.hours.opens) > Date.parse(site.now ?? ""))
    return t("en", "site.open.later", { time: clockWords(site.hours.opens, tz) });
  return t("en", "site.open.closed");
}

export function priceLines(site: SiteView): string[] {
  const p = site.prices;
  const allIn = p.wording === "allIn";
  const lines: string[] = [];
  if (p.per_person_cents !== null)
    lines.push(
      t("en", allIn ? "site.price.perPersonAllIn" : "site.price.perPerson", {
        amount: money(p.per_person_cents),
        pct: p.gratuity_pct,
      }),
    );
  if (p.vip)
    lines.push(
      t("en", allIn ? "site.price.vipAllIn" : "site.price.vip", {
        amount: money(p.vip.hourly_cents),
      }),
    );
  return lines;
}

export function addressLine(site: SiteView): string {
  const a = site.venue.address;
  return a ? [a.line1, a.city].filter(Boolean).join(", ") : "";
}

export function SiteHeader({ site, base }: { site: SiteView; base: string }) {
  return (
    <header className="site-header">
      <a className="site-name" href={base || "/"}>
        {site.venue.name}
      </a>
      <nav aria-label={site.venue.name}>
        {site.modules.rooms && <a href={`${base}/#rooms`}>{t("en", "site.nav.rooms")}</a>}
        <a href={`${base}/#menu`}>{t("en", "site.nav.menu")}</a>
        <a href={`${base}/parties`}>{t("en", "site.nav.parties")}</a>
        {site.modules.booking && <a href={`${base}/book`}>{t("en", "site.nav.book")}</a>}
      </nav>
    </header>
  );
}

export function SiteFooter({ site, base }: { site: SiteView; base: string }) {
  return (
    <footer className="site-footer">
      <p>{t("en", "site.footer.age", { address: addressLine(site) })}</p>
      {site.phone && (
        <p>
          <a href={`tel:${site.phone}`}>{phoneLabel(site.phone)}</a>
        </p>
      )}
      <p>
        <a href={`${base}/parties`}>{t("en", "site.nav.parties")} →</a>
      </p>
    </footer>
  );
}

export function BookButton({ site, base }: { site: SiteView; base: string }) {
  // Booking off: the hero reads "Call to book" with the venue's number (screens Main note 2).
  if (!site.modules.booking)
    return site.phone ? (
      <a className="button" href={`tel:${site.phone}`}>
        {t("en", "site.hero.callToBook")} · {phoneLabel(site.phone)}
      </a>
    ) : null;
  return (
    <a className="button" href={`${base}/book`}>
      {t("en", "site.hero.book")}
    </a>
  );
}

export function RoomsSection({ site, base, path }: { site: SiteView; base: string; path: string }) {
  const r = site.rooms;
  const max = Math.max(...r.tiers.map((x) => x.capacityMax), 1);
  const link = (n: number) => `${path}?guests=${n}#rooms`;
  return (
    <section id="rooms" className="site-rooms" aria-labelledby="rooms-h">
      <p className="kicker">{t("en", "site.rooms")}</p>
      <h2 id="rooms-h">{site.content.rooms.heading}</h2>
      <p>{site.content.rooms.lead}</p>
      <div className="picker" aria-label={t("en", "site.rooms.howMany")}>
        <p>{t("en", "site.rooms.howMany")}</p>
        <a
          className="button secondary"
          href={link(Math.max(1, r.guests - 1))}
          aria-label={t("en", "site.rooms.fewer")}
        >
          −
        </a>
        <output aria-live="polite">{t("en", "site.rooms.people", { n: r.guests })}</output>
        <a
          className="button secondary"
          href={link(Math.min(max + 1, r.guests + 1))}
          aria-label={t("en", "site.rooms.more")}
        >
          +
        </a>
      </div>
      {r.fit ? (
        <div className="fit" role="status">
          <p>
            <strong>
              {t("en", "site.rooms.fit", {
                tier: t("en", `site.tier.${r.fit.tier}` as MessageKey),
              })}
            </strong>
          </p>
          <p>
            {r.fit.billable_guests > r.guests
              ? t("en", "site.rooms.billed", {
                  amount: money(r.fit.hourly_cents),
                  min: r.fit.billable_guests,
                })
              : t("en", "site.rooms.cost", { amount: money(r.fit.hourly_cents) })}
          </p>
          {site.modules.booking && (
            <a className="button" href={`${base}/book?guests=${r.guests}`}>
              {t("en", "site.rooms.bookIt")}
            </a>
          )}
        </div>
      ) : (
        <p role="status">{t("en", "site.rooms.tooMany")}</p>
      )}
      <ul className="price-lines">
        {priceLines(site).map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </section>
  );
}

export function Home({ site, base, path }: { site: SiteView; base: string; path: string }) {
  const c = site.content;
  const p = site.prices;
  return (
    <>
      <SiteHeader site={site} base={base} />
      <main className="guest site">
        <section className="hero" aria-labelledby="hero-h">
          <p className="kicker">{addressLine(site)}</p>
          <h1 id="hero-h">{c.hero.headline}</h1>
          <p className="lead">{c.hero.lead}</p>
          <BookButton site={site} base={base} />
          <p className="open-line" role="status">
            {openLine(site)}
          </p>
        </section>

        <section aria-labelledby="numbers-h">
          <h2 id="numbers-h" className="kicker">
            {t("en", "site.numbers")}
          </h2>
          <dl className="numbers">
            {c.numbers.map((n) => (
              <div key={n.value}>
                <dt>{n.value}</dt>
                <dd>{n.text}</dd>
              </div>
            ))}
            {p.per_person_cents !== null && (
              <div>
                <dt>{money(p.per_person_cents)}</dt>
                <dd>
                  {t("en", p.wording === "allIn" ? "site.number.priceAllIn" : "site.number.price", {
                    pct: p.gratuity_pct,
                  })}
                </dd>
              </div>
            )}
          </dl>
        </section>

        <section aria-labelledby="songs-h">
          <p className="kicker">{t("en", "site.songbook")}</p>
          <h2 id="songs-h">{c.songbook.heading}</h2>
          {site.songs.count !== null && (
            <p>
              {t("en", "site.songbook.count", { count: site.songs.count.toLocaleString("en-US") })}
            </p>
          )}
        </section>

        {c.singAtTheBar && (
          <section aria-labelledby="bar-h">
            <p className="kicker">{t("en", "site.bar")}</p>
            <h2 id="bar-h">{c.singAtTheBar.heading}</h2>
            <p>{c.singAtTheBar.lead}</p>
          </section>
        )}

        <section id="menu" aria-labelledby="menu-h">
          <h2 id="menu-h">{t("en", "site.menu.title")}</h2>
          <dl className="menu-teaser">
            {site.menu.slice(0, 6).map((m) => (
              <div key={m.name}>
                <dt>{m.name}</dt>
                <dd>
                  {m.fromCents === m.toCents
                    ? money(m.fromCents)
                    : t("en", "site.menu.from", { amount: money(m.fromCents) })}
                </dd>
              </div>
            ))}
          </dl>
          <a href={`${base}/menu`}>{t("en", "site.menu.full")}</a>
        </section>

        <section aria-labelledby="rules-h">
          <h2 id="rules-h">{t("en", "site.houseRules")}</h2>
          <ol className="house-rules">
            {c.houseRules.map((rule, i) => (
              <li key={rule}>
                {rule}
                {i === 0 && site.modules.waitlist && (
                  <>
                    {" "}
                    <a href={`/v/${site.venue.slug}/waitlist`}>{t("en", "site.waitlist.join")}</a>
                  </>
                )}
              </li>
            ))}
          </ol>
        </section>

        {site.modules.rooms && <RoomsSection site={site} base={base} path={path} />}

        <section aria-labelledby="find-h">
          <h2 id="find-h">{t("en", "site.findUs")}</h2>
          <dl className="find-us">
            <dt>{t("en", "site.findUs.address")}</dt>
            <dd>
              {site.venue.address?.line1}
              <br />
              {[
                site.venue.address?.city,
                site.venue.address?.region,
                site.venue.address?.postal_code,
              ]
                .filter(Boolean)
                .join(", ")}
              <br />
              {c.findUs.directions}
            </dd>
            {site.phone && (
              <>
                <dt>{t("en", "site.findUs.call")}</dt>
                <dd>
                  <a href={`tel:${site.phone}`}>{phoneLabel(site.phone)}</a>
                </dd>
              </>
            )}
            <dt>{t("en", "site.findUs.hours")}</dt>
            <dd>
              <ul className="hours">
                {site.hours.weekly.map((w) => (
                  <li key={w.day}>
                    {t("en", `day.${w.day}` as MessageKey)}{" "}
                    {t("en", "site.findUs.hoursRow", {
                      opens: hhmmWords(w.opens),
                      closes: hhmmWords(w.closes),
                    })}
                  </li>
                ))}
              </ul>
            </dd>
            <dt>{t("en", "site.findUs.rightNow")}</dt>
            <dd>{openLine(site)}</dd>
            {c.findUs.social.map((s) => (
              <Fragment key={s.label}>
                <dt>{s.label}</dt>
                <dd>{s.handle}</dd>
              </Fragment>
            ))}
          </dl>
        </section>
      </main>
      <SiteFooter site={site} base={base} />
    </>
  );
}
