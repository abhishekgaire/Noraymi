import { useCallback, useEffect, useState } from "react";
import type { Cents } from "@west4/shared";
import { api } from "../api.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";

/**
 * Night's tips panel (M7-09; screens Night notes 1 and 2): the gratuity from
 * room checks, card tips and cash tips, the pool to share, each person's
 * minutes and share, and who isn't in the pool ("Not in the pool: Andy C.,
 * manager."). Late tips earned on an earlier night say which night they're for.
 */
interface Share {
  readonly for_business_date: string;
  readonly user_id: string;
  readonly name: string;
  readonly duty: string;
  readonly minutes: number;
  readonly total_cents: number;
}
interface Tips {
  readonly business_date: string;
  readonly pool: { readonly method: "hours" | "even" | "roomServer"; readonly status: string };
  readonly sources: {
    readonly gratuity_cents: number;
    readonly card_tip_cents: number;
    readonly cash_tip_cents: number;
    readonly total_cents: number;
  };
  readonly shares: readonly Share[];
  readonly left_out: readonly {
    readonly name: string;
    readonly reason: "manager" | "not_eligible";
  }[];
  readonly house_absorbed: readonly { readonly check_id: string; readonly cents: number }[];
}

export function TipsPanel({ venueId, date: night }: { venueId: string; date: string }) {
  const { t, money, date } = useT();
  const { subscribe } = useEvents();
  const [tips, setTips] = useState<Tips | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    try {
      setTips(await api<Tips>("GET", `/v1/venues/${venueId}/nights/${night}/tips`));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [venueId, night]);
  useEffect(() => void load(), [load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (
          events.length === 0 ||
          events.some(
            (e) =>
              e.type.startsWith("payment.") ||
              e.type.startsWith("check.") ||
              e.type.startsWith("shift."),
          )
        )
          void load();
      }),
    [subscribe, load],
  );
  if (failed && !tips)
    return (
      <p role="alert" className="error">
        {t("tipsPanel.failed")}
      </p>
    );
  if (!tips) return <p role="status">{t("shell.loading")}</p>;
  const m = (c: number) => money(c as Cents);
  const rows: [string, number][] = [
    [t("tipsPanel.gratuity"), tips.sources.gratuity_cents],
    [t("tipsPanel.cardTips"), tips.sources.card_tip_cents],
    [t("tipsPanel.cashTips"), tips.sources.cash_tip_cents],
    [t("tipsPanel.pool"), tips.sources.total_cents],
  ];
  const hours = (minutes: number) =>
    t("tipsPanel.hours", { h: Math.floor(minutes / 60), m: minutes % 60 });
  return (
    <section className="tips-panel" aria-labelledby="tips-title">
      <h2 id="tips-title">{t("tipsPanel.title")}</h2>
      <dl className="drawer-figures">
        {rows.map(([label, cents]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{m(cents)}</dd>
          </div>
        ))}
      </dl>
      {tips.shares.length === 0 ? (
        <p className="muted">{t("tipsPanel.none")}</p>
      ) : (
        <ul className="tips-shares">
          {tips.shares.map((s) => (
            <li key={`${s.for_business_date}-${s.user_id}-${s.duty}`} className="row">
              <span>
                <strong>{s.name}</strong>{" "}
                <span className="small muted">
                  {hours(s.minutes)}
                  {s.for_business_date !== tips.business_date
                    ? ` · ${t("tipsPanel.earned", { date: date(s.for_business_date) })}`
                    : ""}
                </span>
              </span>
              <span>{m(s.total_cents)}</span>
            </li>
          ))}
        </ul>
      )}
      {tips.left_out.length > 0 && (
        <p className="small">
          {t("tipsPanel.notInPool", {
            names: tips.left_out
              .map((l) =>
                t(l.reason === "manager" ? "tipsPanel.manager" : "tipsPanel.notEligible", {
                  name: l.name,
                }),
              )
              .join("; "),
          })}
        </p>
      )}
      {tips.house_absorbed.map((h) => (
        <p key={h.check_id} className="small muted">
          {t("tipsPanel.absorbed", { amount: m(-h.cents) })}
        </p>
      ))}
    </section>
  );
}
