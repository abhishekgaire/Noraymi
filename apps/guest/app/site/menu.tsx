import { t, type MessageKey } from "@west4/shared";
import { SiteFooter, SiteHeader, priceLines } from "./home";
import { hhmmWords, minuteWords, money, type GuestMenu, type SiteView } from "./data";

/**
 * The menu page (M5-03; screens Menu): every shown item with its variants,
 * choices and prices, from the same list the room page and the menu PDF read.
 * An 86'd item stays in its slot, greyed and marked "86'd tonight"; a hidden
 * one is gone. The happy-hour banner comes only from dated price rules the
 * promotion checks pass, and isn't there when there are none. Then packages,
 * the room price line, hours, house rules and the PDF. Server-rendered.
 */
const dayList = (days: readonly number[]) =>
  days.length === 7
    ? t("en", "site.menuPage.everyDay")
    : days.map((d) => t("en", `day.${d}` as MessageKey)).join(", ");

export function MenuPage({
  site,
  menu,
  pdf,
  base,
}: {
  site: SiteView;
  menu: GuestMenu;
  pdf: string | null;
  base: string;
}) {
  return (
    <>
      <SiteHeader site={site} base={base} />
      <main className="guest site menu-page">
        <section className="hero" aria-labelledby="menu-h">
          <h1 id="menu-h">{t("en", "site.menuPage.title")}</h1>
          {pdf && (
            <a className="button secondary" href={pdf}>
              {t("en", "site.menuPage.pdf")}
            </a>
          )}
        </section>

        {menu.happy_hours.length > 0 && (
          <section className="happy-hour" aria-labelledby="hh-h">
            <h2 id="hh-h">{t("en", "site.menuPage.happyHour")}</h2>
            <ul>
              {menu.happy_hours.map((h) => (
                <li key={h.name}>
                  <strong>{h.name}</strong> · {dayList(h.days)}
                  {h.from_min !== null && h.to_min !== null && (
                    <>
                      {" · "}
                      {t("en", "site.findUs.hoursRow", {
                        opens: minuteWords(h.from_min),
                        closes: minuteWords(h.to_min),
                      })}
                    </>
                  )}
                  {" · "}
                  {h.pct_off !== null
                    ? t("en", "site.menuPage.pctOff", { pct: h.pct_off })
                    : h.qty > 1
                      ? t("en", "site.menuPage.forPrice", {
                          qty: h.qty,
                          amount: money(h.price_cents ?? 0),
                        })
                      : money(h.price_cents ?? 0)}
                  {h.items.length > 0 && <> · {h.items.join(", ")}</>}
                </li>
              ))}
            </ul>
          </section>
        )}

        {menu.categories.map((cat) => (
          <section key={cat.id} className="menu-category" aria-labelledby={`cat-${cat.id}`}>
            <h2 id={`cat-${cat.id}`}>{cat.name}</h2>
            <ul>
              {cat.items.flatMap((item) =>
                item.variants.map((v) => {
                  const out = item.out_tonight || v.out_tonight;
                  const name = item.variants.length > 1 ? `${item.name} · ${v.name}` : item.name;
                  return (
                    <li key={v.id} className={out ? "menu-row out" : "menu-row"} data-menu-row>
                      <p className="line">
                        <span className="name">{name}</span>{" "}
                        <span className="price">
                          {out
                            ? t(
                                "en",
                                item.kitchen_stop
                                  ? "site.menuPage.kitchenClosed"
                                  : "site.menuPage.out",
                              )
                            : money(v.price_cents)}
                        </span>
                      </p>
                      {item.description && v === item.variants[0] && (
                        <p className="desc">{item.description}</p>
                      )}
                      {v === item.variants[0] &&
                        item.groups.map((g) => (
                          <p key={g.id} className="choices">
                            {g.name}:{" "}
                            {g.options
                              .map((o) =>
                                o.out_tonight
                                  ? `${o.name} (${t("en", "site.menuPage.out")})`
                                  : o.price_delta_cents > 0
                                    ? `${o.name} +${money(o.price_delta_cents)}`
                                    : o.name,
                              )
                              .join(", ")}
                          </p>
                        ))}
                    </li>
                  );
                }),
              )}
            </ul>
          </section>
        ))}

        {site.sections.packages && menu.packages.length > 0 && (
          <section aria-labelledby="packs-h">
            <h2 id="packs-h">{t("en", "site.menuPage.packages")}</h2>
            <ul>
              {menu.packages.map((p) => (
                <li key={p.name} className="menu-row">
                  <p className="line">
                    <span className="name">{p.name}</span>{" "}
                    <span className="price">
                      {p.hourly
                        ? t("en", "site.parties.packageHourly", { amount: money(p.price_cents) })
                        : money(p.price_cents)}
                    </span>
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {site.modules.rooms && (
          <section aria-labelledby="rooms-price-h">
            <h2 id="rooms-price-h">{t("en", "site.menuPage.rooms")}</h2>
            {priceLines(site).map((line) => (
              <p key={line}>{line}</p>
            ))}
          </section>
        )}

        <section aria-labelledby="menu-hours-h">
          <h2 id="menu-hours-h">{t("en", "site.findUs.hours")}</h2>
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
        </section>

        <section aria-labelledby="menu-rules-h">
          <h2 id="menu-rules-h">{t("en", "site.houseRules")}</h2>
          <ol className="house-rules">
            {site.content.houseRules.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ol>
        </section>
      </main>
      <SiteFooter site={site} base={base} />
    </>
  );
}
