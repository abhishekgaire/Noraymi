import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Link } from "react-router";
import type { Cents } from "@west4/shared";
import { api, stepUpToken } from "../api.js";
import { useVenueTime } from "../clock.js";
import { useT } from "../i18n.js";
import "./desk.css";
import { useSession } from "../session.js";

/**
 * Reports (M7-18; screens DeskReports, Reports and N38): tonight's report as
 * the running X report until the close and the Z report after it, linked to
 * Close the night; this week by night and the 8-week trend; "Reviews from the
 * morning text", Off while the Review ask text is off; tonight's exceptions;
 * the tax quarter; and the exports, each asking for the passkey again.
 * Desktop and phone; English and Spanish.
 */
interface Sales {
  readonly this_week: { readonly start: string; readonly end: string; readonly net_cents: number };
  readonly nights: readonly { readonly date: string; readonly net_cents: number }[];
  readonly weeks: readonly { readonly start: string; readonly net_cents: number }[];
  readonly reviews: { readonly review_ask_on: boolean };
}
interface Exception {
  readonly kind: string;
  readonly status: string;
  readonly where: string;
  readonly why: string | null;
  readonly asked_by: string | null;
  readonly approved_by: string | null;
  readonly waiting_for?: string | null;
  readonly amount_cents: number;
}
interface Night {
  readonly kind: "x" | "z";
  readonly closed: { readonly z_number: number } | null;
  readonly sales: { readonly net_cents: number };
  readonly gratuity: { readonly total_cents: number };
}
interface Quarter {
  readonly quarter: { readonly label: string; readonly start: string; readonly end: string };
  readonly tax_cents: number;
}

export function Reports() {
  const { t, money, date } = useT();
  const { state } = useSession();
  const signedIn = state.status === "signedIn" ? state : null;
  const venueId = signedIn?.membership.venue_id ?? "";
  const venueTime = useVenueTime(
    signedIn?.membership.venue.time_zone ?? "America/New_York",
    signedIn?.membership.venue.day_cutover ?? "06:00",
  );
  const tonight = venueTime?.businessDate.toString() ?? null;
  const [sales, setSales] = useState<Sales | null>(null);
  const [night, setNight] = useState<Night | null>(null);
  const [exceptions, setExceptions] = useState<readonly Exception[] | null>(null);
  const [quarter, setQuarter] = useState<Quarter | null>(null);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const load = useCallback(async () => {
    if (!venueId || !tonight) return;
    try {
      const v = `/v1/venues/${venueId}`;
      const [s, n, e, q] = await Promise.all([
        api<Sales>("GET", `${v}/reports/sales?to=${tonight}`),
        api<Night>("GET", `${v}/nights/${tonight}/report`),
        api<{ exceptions: Exception[] }>("GET", `${v}/reports/exceptions?date=${tonight}`),
        api<Quarter>("GET", `${v}/reports/tax-quarter?date=${tonight}`),
      ]);
      setSales(s);
      setNight(n);
      setExceptions(e.exceptions);
      setQuarter(q);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [venueId, tonight]);
  useEffect(() => void load(), [load]);

  const m = (c: number) => money(c as Cents);
  /** A file the API hands back, saved in the browser; the passkey is asked first. */
  const download = async (path: string) => {
    setNotice(null);
    try {
      const r = await api<{ file: string; filename: string }>(
        "GET",
        `/v1/venues/${venueId}${path}`,
        undefined,
        {
          stepUp: await stepUpToken(),
        },
      );
      const url = URL.createObjectURL(new Blob([r.file], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = r.filename;
      a.click();
      URL.revokeObjectURL(url);
      setNotice(t("qb.downloaded"));
    } catch {
      setNotice(t("reports.exportFailed"));
    }
  };
  const emailNight = async () => {
    setNotice(null);
    try {
      const got = await api<{ export_id: string }>(
        "GET",
        `/v1/venues/${venueId}/exports/accounting?date=${from}`,
        undefined,
        { stepUp: await stepUpToken() },
      );
      await api(
        "POST",
        `/v1/venues/${venueId}/exports/${got.export_id}/email`,
        {},
        { stepUp: await stepUpToken() },
      );
      setNotice(t("reports.emailed"));
    } catch {
      setNotice(t("reports.exportFailed"));
    }
  };

  if (failed && !sales)
    return (
      <section className="screen">
        <h1>{t("menu.reports")}</h1>
        <p role="alert" className="error">
          {t("reports.failed")}
        </p>
      </section>
    );
  if (!sales || !night || !exceptions || !quarter)
    return (
      <section className="screen">
        <h1>{t("menu.reports")}</h1>
        <p role="status">{t("shell.loading")}</p>
      </section>
    );
  const best = Math.max(1, ...sales.weeks.map((w) => w.net_cents));
  return (
    <section className="screen reports desk" aria-labelledby="reports-title">
      <div className="desk-head">
        <h1 id="reports-title">{t("menu.reports")}</h1>
      </div>
      <div className="desk-cols three">
        <section className="card desk-card report-kpi" aria-labelledby="tonight-title">
          <h2 id="tonight-title">
            {night.kind === "z" && night.closed
              ? t("report.z", { n: night.closed.z_number })
              : t("report.x")}
          </h2>
          <dl className="drawer-figures">
            <div>
              <dt>{t("report.net")}</dt>
              <dd>{m(night.sales.net_cents)}</dd>
            </div>
            <div>
              <dt>{t("myTips.gratuity")}</dt>
              <dd>{m(night.gratuity.total_cents)}</dd>
            </div>
          </dl>
          <Link to="/close-the-night" className="link">
            {t("menu.closeNight")}
          </Link>
        </section>

        <section className="card desk-card report-kpi" aria-labelledby="week-title">
          <h2 id="week-title">
            {t("reports.thisWeek", {
              from: date(sales.this_week.start),
              to: date(sales.this_week.end),
            })}
          </h2>
          <ul className="tips-shares">
            {sales.nights.map((n) => (
              <li key={n.date} className="row">
                <span>{date(n.date)}</span>
                <span>{m(n.net_cents)}</span>
              </li>
            ))}
          </ul>
          <p>
            <strong>{t("reports.weekTotal", { amount: m(sales.this_week.net_cents) })}</strong>
          </p>
          <p className="small muted">
            {sales.reviews.review_ask_on ? t("reports.reviewsOn") : t("reports.reviewsOff")}
          </p>
        </section>

        <section className="card desk-card report-kpi" aria-labelledby="quarter-title">
          <h2 id="quarter-title">
            {t("reports.taxQuarter", {
              from: date(quarter.quarter.start),
              to: date(quarter.quarter.end),
            })}
          </h2>
          <p>{t("reports.taxSoFar", { amount: m(quarter.tax_cents) })}</p>
          <button
            type="button"
            className="secondary"
            onClick={() => void download(`/reports/tax-quarter?date=${tonight}&format=csv`)}
          >
            {t("reports.downloadTax")}
          </button>
        </section>
      </div>
      <div className="desk-cols two">
        <section className="card desk-card" aria-labelledby="trend-title">
          <h2 id="trend-title">{t("reports.trends")}</h2>
          <ul className="trend">
            {sales.weeks.map((w) => (
              <li key={w.start}>
                <span className="small">{date(w.start)}</span>
                <span
                  className="bar"
                  style={
                    { "--share": `${Math.round((w.net_cents / best) * 100)}%` } as CSSProperties
                  }
                />
                <span className="small">{m(w.net_cents)}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="card desk-card" aria-labelledby="exceptions-title">
          <h2 id="exceptions-title">{t("reports.exceptions")}</h2>
          {exceptions.length === 0 && <p className="muted">{t("reports.noExceptions")}</p>}
          <ul className="tips-shares">
            {exceptions.map((x, i) => (
              <li key={i} className="row">
                <span>
                  {t(`reports.kind.${x.kind}` as never)} · {x.where} · {x.asked_by ?? ""}
                  {x.waiting_for
                    ? ` · ${t("drawer.waitingFor", { name: x.waiting_for })}`
                    : x.approved_by
                      ? ` · ${t("reports.approvedBy", { name: x.approved_by })}`
                      : ""}
                  {x.why ? <span className="small muted"> · {x.why}</span> : null}
                </span>
                <span>{m(x.amount_cents)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="card desk-card" aria-labelledby="exports-title">
        <h2 id="exports-title">{t("reports.exports")}</h2>
        <p className="small muted">{t("reports.exportsHint")}</p>
        <div className="actions">
          <input
            type="date"
            aria-label={t("payroll.from")}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
          <input
            type="date"
            aria-label={t("payroll.to")}
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <div className="actions">
          <button
            type="button"
            disabled={!from}
            onClick={() => void download(`/exports/accounting?date=${from}`)}
          >
            {t("reports.downloadBooks")}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!from}
            onClick={() => void emailNight()}
          >
            {t("reports.emailCsv")}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!from || !to}
            onClick={() => void download(`/exports/payroll?from=${from}&to=${to}`)}
          >
            {t("payroll.title")}
          </button>
        </div>
        {notice && (
          <p role="status" className="small">
            {notice}
          </p>
        )}
      </section>
    </section>
  );
}
