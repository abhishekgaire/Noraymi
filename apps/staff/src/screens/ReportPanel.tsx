import { useCallback, useEffect, useState } from "react";
import type { Cents } from "@west4/shared";
import { api } from "../api.js";
import { useT } from "../i18n.js";

/**
 * Night's report panel (M7-13; screens Night notes 2, 3, 10 and 11): the
 * running X report until the close, the Z report after it, with sales (drinks
 * split into room checks and bar tabs), tax, the gratuity from room checks,
 * payments, rooms and bar tabs counted apart, and adjustments for earlier
 * nights. Print sends it to the front-desk receipt printer.
 */
interface Report {
  readonly kind: "x" | "z";
  readonly closed: { readonly z_number: number } | null;
  readonly sales: Readonly<Record<string, number>>;
  readonly tax_cents: number;
  readonly gratuity: { readonly total_cents: number };
  readonly counts: { readonly rooms: number; readonly bar_tabs: number };
  readonly payments: Readonly<Record<string, number>>;
  /** Missed sales (P-19): earlier nights' sales rung up on this one; absent on a Z report stored before them. */
  readonly missed_sales?: {
    readonly sales_cents: number;
    readonly checks: readonly {
      readonly check: string;
      readonly where: string;
      readonly from_date: string;
      readonly reason: string;
      readonly sales_cents: number;
    }[];
  };
  /** Tax-exempt checks (P-15); absent on a Z report stored before them. */
  readonly tax_exempt?: {
    readonly sales_cents: number;
    readonly checks: readonly {
      readonly check: string;
      readonly where: string;
      readonly organization: string;
      readonly certificate_no: string;
      readonly exempt_sales_cents: number;
    }[];
  };
  readonly adjustments: readonly {
    readonly what: string;
    readonly for_business_date: string;
    readonly amount_cents: number;
  }[];
}

export function ReportPanel({ venueId, date: night }: { venueId: string; date: string }) {
  const { t, money, date } = useT();
  const [report, setReport] = useState<Report | null>(null);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setReport(await api<Report>("GET", `/v1/venues/${venueId}/nights/${night}/report`));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [venueId, night]);
  useEffect(() => void load(), [load]);
  if (failed && !report)
    return (
      <p role="alert" className="error">
        {t("report.failed")}
      </p>
    );
  if (!report) return <p role="status">{t("shell.loading")}</p>;
  const m = (c: number | undefined) => money((c ?? 0) as Cents);
  const rows: [string, number | undefined][] = [
    [t("report.roomTime"), report.sales["room_time_cents"]],
    [t("report.drinksRooms"), report.sales["drinks_room_checks_cents"]],
    [t("report.drinksBar"), report.sales["drinks_bar_tabs_cents"]],
    [t("report.food"), report.sales["food_cents"]],
    [t("report.comps"), report.sales["comps_cents"]],
    // Discounts on whole checks (P-02) and cash discounts, when there were any.
    ...((report.sales["discounts_cents"] ?? 0) !== 0
      ? ([[t("report.discounts"), report.sales["discounts_cents"]]] as [string, number][])
      : []),
    [t("report.refunds"), report.sales["refunds_cents"]],
    [t("report.net"), report.sales["net_cents"]],
    [t("report.tax"), report.tax_cents],
    [t("myTips.gratuity"), report.gratuity.total_cents],
    [t("report.cards"), report.payments["card_total_cents"]],
    [t("report.cash"), report.payments["cash_cents"]],
    // The venue's own outside card machine (F-10; D126), when it took anything: its total and tips,
    // then by person, to match against the machine's own batch report.
    ...((report.payments["outside_card_total_cents"] ?? 0) > 0
      ? ([
          [t("report.outsideCard"), report.payments["outside_card_cents"]],
          [t("report.outsideCardTips"), report.payments["outside_card_tips_cents"]],
          ...(
            (
              report.payments as unknown as {
                outside_card_by_person?: { name: string; cents: number }[];
              }
            ).outside_card_by_person ?? []
          ).map((p): [string, number] => [t("report.outsideCardBy", { name: p.name }), p.cents]),
        ] as [string, number | undefined][])
      : []),
  ];
  const print = async () => {
    setNotice(null);
    try {
      await api("POST", `/v1/venues/${venueId}/nights/${night}/report/print`, {
        kind: report.kind,
      });
      setNotice(t("report.printed"));
    } catch {
      setNotice(t("report.printFailed"));
    }
  };
  return (
    <section className="card report-panel" aria-labelledby="report-title">
      <h2 id="report-title">
        {report.kind === "z" && report.closed
          ? t("report.z", { n: report.closed.z_number })
          : t("report.x")}
      </h2>
      <p className="small muted">
        {t("report.counts", { rooms: report.counts.rooms, tabs: report.counts.bar_tabs })}
      </p>
      <dl className="drawer-figures">
        {rows.map(([label, cents]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{m(cents)}</dd>
          </div>
        ))}
      </dl>
      {(report.missed_sales?.checks.length ?? 0) > 0 && (
        <>
          <h3>{t("report.missedSales")}</h3>
          <ul className="tips-shares" data-testid="report-missed-sales">
            {report.missed_sales!.checks.map((x) => (
              <li key={x.check} className="row">
                <span>
                  {t("report.missedSaleCheck", {
                    where: x.where,
                    date: x.from_date,
                    reason: x.reason,
                  })}
                </span>
                <span>{m(x.sales_cents)}</span>
              </li>
            ))}
            <li className="row">
              <span>{t("report.missedSales")}</span>
              <span>{m(report.missed_sales!.sales_cents)}</span>
            </li>
          </ul>
        </>
      )}
      {(report.tax_exempt?.checks.length ?? 0) > 0 && (
        <>
          <h3>{t("report.taxExempt")}</h3>
          <ul className="tips-shares" data-testid="report-tax-exempt">
            {report.tax_exempt!.checks.map((x) => (
              <li key={x.check} className="row">
                <span>
                  {t("report.taxExemptCheck", {
                    where: x.where,
                    organization: x.organization,
                    certificate: x.certificate_no,
                  })}
                </span>
                <span>{m(x.exempt_sales_cents)}</span>
              </li>
            ))}
            <li className="row">
              <span>{t("report.taxExempt")}</span>
              <span>{m(report.tax_exempt!.sales_cents)}</span>
            </li>
          </ul>
        </>
      )}
      {report.adjustments.length > 0 && (
        <>
          <h3>{t("report.adjustments")}</h3>
          <ul className="tips-shares">
            {report.adjustments.map((a, i) => (
              <li key={i} className="row">
                <span>{t("report.adjustmentFor", { date: date(a.for_business_date) })}</span>
                <span>{m(a.amount_cents)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <button type="button" className="secondary" onClick={() => void print()}>
        {report.kind === "z" ? t("nightCheck.printZ") : t("nightCheck.printX")}
      </button>
      {notice && (
        <p role="status" className="small">
          {notice}
        </p>
      )}
    </section>
  );
}
