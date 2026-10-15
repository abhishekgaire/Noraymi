import { useCallback, useEffect, useState } from "react";
import type { Cents } from "@west4/shared";
import { api } from "../api.js";
import { useT } from "../i18n.js";

/**
 * Reports → Month (P-07; Money rules 16): a month picker, the month's totals
 * from its closed nights' Z reports, each night, and the CSV (the passkey is
 * asked again). The month in progress says so, and a past night with sales
 * that hasn't been closed is named as not counted. English and Spanish.
 */
type Figure =
  | "room_time_cents"
  | "drinks_room_checks_cents"
  | "drinks_bar_tabs_cents"
  | "food_cents"
  | "packages_cents"
  | "songs_cents"
  | "damage_cents"
  | "kept_deposits_cents"
  | "min_spend_cents"
  | "card_surcharge_cents"
  | "fees_cents"
  | "comps_cents"
  | "voids_cents"
  | "discounts_cents"
  | "refunds_cents"
  | "net_cents"
  | "tax_cents"
  | "gratuity_cents"
  | "card_tips_cents"
  | "cash_tips_cents"
  | "outside_card_tips_cents"
  | "cash_cents"
  | "card_cents"
  | "outside_card_cents"
  | "payment_refunds_cents"
  | "room_minutes";
interface Month {
  readonly month: string;
  readonly in_progress: boolean;
  readonly not_closed: readonly string[];
  readonly nights: readonly (Record<Figure, number> & {
    readonly business_date: string;
    readonly z_number: number;
  })[];
  readonly totals: Record<Figure, number>;
}

/** Always shown; the rest only when the month has any. */
const SALES: readonly (readonly [Figure, boolean])[] = [
  ["room_time_cents", true],
  ["drinks_room_checks_cents", true],
  ["drinks_bar_tabs_cents", true],
  ["food_cents", false],
  ["packages_cents", false],
  ["songs_cents", false],
  ["damage_cents", false],
  ["kept_deposits_cents", false],
  ["min_spend_cents", false],
  ["card_surcharge_cents", false],
  ["fees_cents", false],
  ["comps_cents", true],
  ["voids_cents", true],
  ["discounts_cents", true],
  ["refunds_cents", true],
  ["net_cents", true],
  ["tax_cents", true],
  ["gratuity_cents", true],
];
const PAID: readonly (readonly [Figure, boolean])[] = [
  ["cash_cents", true],
  ["card_cents", true],
  ["outside_card_cents", false],
  ["card_tips_cents", true],
  ["cash_tips_cents", true],
  ["outside_card_tips_cents", false],
  ["payment_refunds_cents", true],
];

/** "2026-09" moved by a number of months. */
function shift(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const n = y * 12 + (m - 1) + by;
  return `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, "0")}`;
}

export function ReportsMonth(props: {
  readonly venueId: string;
  readonly tonight: string;
  readonly download: (path: string) => Promise<void>;
}) {
  const { t, money, date } = useT();
  const [month, setMonth] = useState(props.tonight.slice(0, 7));
  const [report, setReport] = useState<Month | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setReport(
        await api<Month>("GET", `/v1/venues/${props.venueId}/reports/month?month=${month}`),
      );
    } catch {
      setReport(null);
      setFailed(true);
    }
  }, [props.venueId, month]);
  useEffect(() => void load(), [load]);

  const m = (c: number) => money(c as Cents);
  const figures = (list: readonly (readonly [Figure, boolean])[], r: Month) =>
    list
      .filter(([k, always]) => always || r.totals[k] !== 0)
      .map(([k]) => (
        <div key={k}>
          <dt>{t(`reports.month.f.${k}` as never)}</dt>
          <dd>{m(r.totals[k])}</dd>
        </div>
      ));
  const current = report?.month === month ? report : null;

  return (
    <section className="card desk-card" aria-labelledby="month-title" data-testid="report-month">
      <h2 id="month-title">{t("reports.month.title")}</h2>
      <div className="actions">
        <button
          type="button"
          className="secondary"
          aria-label={t("reports.month.previous")}
          onClick={() => setMonth((x) => shift(x, -1))}
        >
          ‹
        </button>
        <input
          type="month"
          aria-label={t("reports.month.pick")}
          value={month}
          onChange={(e) => {
            if (/^\d{4}-\d{2}$/.test(e.target.value)) setMonth(e.target.value);
          }}
        />
        <button
          type="button"
          className="secondary"
          aria-label={t("reports.month.next")}
          onClick={() => setMonth((x) => shift(x, 1))}
        >
          ›
        </button>
      </div>
      {failed && (
        <p role="alert" className="error">
          {t("reports.month.failed")}
        </p>
      )}
      {!failed && !current && <p role="status">{t("shell.loading")}</p>}
      {current && (
        <>
          {current.in_progress && (
            <p className="small muted" role="status">
              {t("reports.month.inProgress")}
            </p>
          )}
          {current.not_closed.length > 0 && (
            <p className="small">
              {t("reports.month.notClosed", {
                dates: current.not_closed.map((d) => date(d)).join(", "),
              })}
            </p>
          )}
          {current.nights.length === 0 ? (
            <p className="muted">{t("reports.month.none")}</p>
          ) : (
            <div className="desk-cols two">
              <div>
                <h3>{t("reports.month.sales")}</h3>
                <dl className="drawer-figures">{figures(SALES, current)}</dl>
                <h3>{t("reports.month.paid")}</h3>
                <dl className="drawer-figures">
                  {figures(PAID, current)}
                  <div>
                    <dt>{t("reports.month.f.room_minutes")}</dt>
                    <dd>
                      {t("reports.month.hours", {
                        h: Math.floor(current.totals.room_minutes / 60),
                        m: current.totals.room_minutes % 60,
                      })}
                    </dd>
                  </div>
                </dl>
              </div>
              <div>
                <h3>{t("reports.month.nights")}</h3>
                <ul className="tips-shares">
                  {current.nights.map((n) => (
                    <li key={n.business_date} className="row">
                      <span>
                        {t("reports.month.night", { date: date(n.business_date), n: n.z_number })}
                      </span>
                      <span>{m(n.net_cents)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          <button
            type="button"
            className="secondary"
            onClick={() => void props.download(`/reports/month?month=${month}&format=csv`)}
          >
            {t("reports.month.download")}
          </button>
        </>
      )}
    </section>
  );
}
