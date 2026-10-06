import { useCallback, useEffect, useState } from "react";
import type { Cents } from "@west4/shared";
import { api } from "../api.js";
import { useT } from "../i18n.js";
import { useSession } from "../session.js";

/**
 * My tips (M7-10; NY Labor Law 146-2.17 records, GA-M2): the signed-in
 * person's own shifts, the tips they collected, and their share of each
 * night's pool, gratuity and tips on separate lines. A late tip says which
 * night it was earned ("for Fri Sep 25 · posted Sat Sep 26"). Owners and
 * managers see their shifts and that managers don't share.
 */
interface MyTipsView {
  readonly never_shares: boolean;
  readonly shifts: readonly {
    readonly id: string;
    readonly business_date: string;
    readonly duty: "bar" | "front_desk" | "runner" | "manager";
    readonly started_at: string;
    readonly ended_at: string | null;
    readonly break_minutes: number;
  }[];
  readonly collected: readonly {
    readonly business_date: string;
    readonly source: "gratuity" | "card_tip" | "cash_tip";
    readonly amount_cents: number;
  }[];
  readonly shares: readonly {
    readonly posted_on: string;
    readonly for_business_date: string;
    readonly minutes: number;
    readonly gratuity_cents: number;
    readonly card_tip_cents: number;
    readonly cash_tip_cents: number;
    readonly final: boolean;
  }[];
  readonly occupations: readonly {
    readonly business_date: string;
    readonly occupation: string;
    readonly share_pct: number;
  }[];
}

const DUTY = {
  bar: "clock.duty.bar",
  front_desk: "clock.duty.front_desk",
  runner: "clock.duty.runner",
  manager: "clock.duty.manager",
} as const;
const SOURCE = {
  gratuity: "myTips.gratuity",
  card_tip: "myTips.cardTips",
  cash_tip: "myTips.cashTips",
} as const;

export function MyTips() {
  const { t, money, time, date } = useT();
  const { state } = useSession();
  const signedIn = state.status === "signedIn" ? state : null;
  const venueId = signedIn?.membership.venue_id ?? "";
  const timeZone = signedIn?.membership.venue.time_zone ?? "America/New_York";
  const [view, setView] = useState<MyTipsView | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    try {
      setView(await api<MyTipsView>("GET", `/v1/venues/${venueId}/me/tips`));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [venueId]);
  useEffect(() => {
    if (venueId) void load();
  }, [venueId, load]);

  const m = (c: number) => money(c as Cents);
  const hours = (minutes: number) =>
    t("tipsPanel.hours", { h: Math.floor(minutes / 60), m: minutes % 60 });
  // One section per business date, newest first: shifts, what was collected, and the shares posted that night.
  const dates = view
    ? [
        ...new Set([
          ...view.shifts.map((s) => s.business_date),
          ...view.collected.map((c) => c.business_date),
          ...view.shares.map((s) => s.posted_on),
        ]),
      ].sort((a, b) => (a < b ? 1 : -1))
    : [];
  return (
    <section className="screen my-tips" aria-labelledby="my-tips-title">
      <h1 id="my-tips-title">{t("myTips.title")}</h1>
      {failed && !view && (
        <p role="alert" className="error">
          {t("myTips.failed")}
        </p>
      )}
      {!view && !failed && <p role="status">{t("shell.loading")}</p>}
      {view?.never_shares && <p className="notice">{t("myTips.never")}</p>}
      {view && dates.length === 0 && <p className="muted">{t("myTips.none")}</p>}
      {view &&
        dates.map((d) => (
          <article key={d} className="card" aria-label={date(d)}>
            <h2>{date(d)}</h2>
            <ul className="tips-shares">
              {view.shifts
                .filter((s) => s.business_date === d)
                .map((s) => (
                  <li key={s.id} className="row">
                    <span>
                      {t(DUTY[s.duty])} · {time(s.started_at, timeZone)} –{" "}
                      {s.ended_at ? time(s.ended_at, timeZone) : t("myTips.onShift")}
                    </span>
                  </li>
                ))}
              {(["gratuity", "card_tip", "cash_tip"] as const).map((source) => {
                const sum = view.collected
                  .filter((c) => c.business_date === d && c.source === source)
                  .reduce((s, c) => s + c.amount_cents, 0);
                return sum === 0 ? null : (
                  <li key={source} className="row">
                    <span>{t("myTips.collected", { what: t(SOURCE[source]) })}</span>
                    <span>{m(sum)}</span>
                  </li>
                );
              })}
            </ul>
            {view.shares
              .filter((s) => s.posted_on === d)
              .map((s) => (
                <div key={`${s.posted_on}-${s.for_business_date}`} className="my-share">
                  <h3>
                    {s.for_business_date === s.posted_on
                      ? t(s.final ? "myTips.share" : "myTips.shareSoFar")
                      : t("myTips.late", {
                          for: date(s.for_business_date),
                          posted: date(s.posted_on),
                        })}
                    <span className="small muted"> · {hours(s.minutes)}</span>
                  </h3>
                  <dl className="drawer-figures">
                    <div>
                      <dt>{t("myTips.gratuity")}</dt>
                      <dd>{m(s.gratuity_cents)}</dd>
                    </div>
                    <div>
                      <dt>{t("myTips.cardTips")}</dt>
                      <dd>{m(s.card_tip_cents)}</dd>
                    </div>
                    <div>
                      <dt>{t("myTips.cashTips")}</dt>
                      <dd>{m(s.cash_tip_cents)}</dd>
                    </div>
                  </dl>
                </div>
              ))}
            {view.occupations.some((o) => o.business_date === d) && (
              <p className="small muted">
                {t("myTips.occupations", {
                  list: view.occupations
                    .filter((o) => o.business_date === d)
                    .map((o) => `${o.occupation} ${o.share_pct}%`)
                    .join(" · "),
                })}
              </p>
            )}
          </article>
        ))}
    </section>
  );
}
