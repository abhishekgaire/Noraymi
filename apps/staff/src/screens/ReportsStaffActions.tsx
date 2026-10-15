import { useCallback, useEffect, useState } from "react";
import type { Cents } from "@west4/shared";
import { ApiCallError, api } from "../api.js";
import { useT } from "../i18n.js";

/**
 * Reports → Staff actions (P-09; Money rules · Close the night and reports):
 * a range of business dates and, per person, the count and dollars of their
 * voids, comps, discounts, refunds, no-sales, paid-outs, over/short, punch
 * edits and cut-offs; each opens its list, every row naming who approved it.
 * Owners and managers (the API refuses everyone else). English and Spanish.
 */
const KINDS = [
  "void",
  "comp",
  "discount",
  "refund",
  "no_sale",
  "paid_out",
  "over_short",
  "punch_edit",
  "cut_off",
] as const;
type Kind = (typeof KINDS)[number];

interface Entry {
  readonly kind: Kind;
  readonly at: string;
  readonly business_date: string;
  readonly where: string | null;
  readonly what: string | null;
  readonly why: string | null;
  readonly amount_cents: number;
  readonly approved_by: string | null;
}
interface Person {
  readonly user_id: string;
  readonly name: string;
  readonly actions: Partial<Record<Kind, { count: number; cents: number }>>;
  readonly entries: readonly Entry[];
}
interface StaffActions {
  readonly from: string;
  readonly to: string;
  readonly people: readonly Person[];
}

/** Kinds whose dollars are shown; the rest are counted only. Over/short keeps its sign. */
const NO_DOLLARS: readonly Kind[] = ["no_sale", "punch_edit", "cut_off"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function ReportsStaffActions(props: {
  readonly venueId: string;
  readonly tonight: string;
  readonly timeZone: string;
}) {
  const { t, money, date, time } = useT();
  const [from, setFrom] = useState(props.tonight);
  const [to, setTo] = useState(props.tonight);
  const [report, setReport] = useState<StaffActions | null>(null);
  const [failed, setFailed] = useState<"load" | "range" | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!DATE.test(from) || !DATE.test(to)) return;
    setFailed(null);
    if (from > to) {
      setReport(null);
      setFailed("range");
      return;
    }
    try {
      setReport(
        await api<StaffActions>(
          "GET",
          `/v1/venues/${props.venueId}/reports/staff-actions?from=${from}&to=${to}`,
        ),
      );
    } catch (e) {
      setReport(null);
      setFailed(e instanceof ApiCallError && e.status === 400 ? "range" : "load");
    }
  }, [props.venueId, from, to]);
  useEffect(() => void load(), [load]);

  const amount = (kind: Kind, cents: number) =>
    kind === "over_short" ? money(cents as Cents) : money(Math.abs(cents) as Cents);
  const current = report?.from === from && report.to === to ? report : null;
  const oneNight = from === to;

  return (
    <section
      className="card desk-card"
      aria-labelledby="staff-actions-title"
      data-testid="report-staff-actions"
    >
      <h2 id="staff-actions-title">{t("reports.staff.title")}</h2>
      <div className="actions">
        <label>
          {t("reports.staff.from")}{" "}
          <input
            type="date"
            value={from}
            max={props.tonight}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label>
          {t("reports.staff.to")}{" "}
          <input
            type="date"
            value={to}
            max={props.tonight}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
      </div>
      {failed && (
        <p role="alert" className="error">
          {t(failed === "range" ? "reports.staff.badRange" : "reports.staff.failed")}
        </p>
      )}
      {!failed && !current && <p role="status">{t("shell.loading")}</p>}
      {current && current.people.length === 0 && <p className="muted">{t("reports.staff.none")}</p>}
      {current && current.people.length > 0 && (
        <ul className="staff-actions">
          {current.people.map((p) => (
            <li key={p.user_id}>
              <h3>{p.name}</h3>
              <ul className="tips-shares">
                {KINDS.filter((k) => p.actions[k]).map((k) => {
                  const a = p.actions[k]!;
                  const key = `${p.user_id}:${k}`;
                  const shown = open === key;
                  const label = NO_DOLLARS.includes(k)
                    ? t("reports.staff.count", { kind: t(`reports.staff.kind.${k}`), n: a.count })
                    : t("reports.staff.summary", {
                        kind: t(`reports.staff.kind.${k}`),
                        n: a.count,
                        amount: amount(k, a.cents),
                      });
                  return (
                    <li key={k}>
                      <button
                        type="button"
                        className="secondary row"
                        aria-expanded={shown}
                        onClick={() => setOpen(shown ? null : key)}
                      >
                        {label}
                      </button>
                      {shown && (
                        <ul className="tips-shares" aria-label={label}>
                          {p.entries
                            .filter((e) => e.kind === k)
                            .map((e, i) => (
                              <li key={i} className="row">
                                <span>
                                  {oneNight ? "" : `${date(e.business_date)} · `}
                                  {time(e.at, props.timeZone)}
                                  {e.where
                                    ? ` · ${k === "punch_edit" ? t(`punches.kind.${e.where}` as never) : e.where}`
                                    : ""}
                                  {e.what ? ` · ${e.what}` : ""}
                                  {` · ${
                                    e.approved_by
                                      ? t("reports.approvedBy", { name: e.approved_by })
                                      : t("reports.staff.noApproval")
                                  }`}
                                  {e.why ? <span className="small muted"> · {e.why}</span> : null}
                                </span>
                                {!NO_DOLLARS.includes(k) && (
                                  <span>{amount(k, e.amount_cents)}</span>
                                )}
                              </li>
                            ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
