import { useCallback, useEffect, useState } from "react";
import type { Cents } from "@west4/shared";
import { api, ApiCallError } from "../api.js";
import { useT } from "../i18n.js";

/**
 * Unmatched payments (M7-14; screens N37 and Night note 8): Stripe activity
 * with no check of ours, such as a break-glass Tap to Pay payment taken in
 * Stripe's Dashboard app. Each shows its amount, card and time; a manager
 * picks the check it belongs to, never for more than that check still owes.
 */
interface Unmatched {
  readonly id: string;
  readonly amount_cents: number;
  readonly card_brand: string | null;
  readonly card_last4: string | null;
  readonly at: string;
}
interface Owing {
  readonly id: string;
  readonly label: string;
  readonly amount_due_cents: number;
}

export function UnmatchedPayments({ venueId, timeZone }: { venueId: string; timeZone: string }) {
  const { t, money, time } = useT();
  const [data, setData] = useState<{ payments: Unmatched[]; checks: Owing[] } | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await api("GET", `/v1/venues/${venueId}/payments/unmatched`));
    } catch {
      setError(t("unmatched.failed"));
    }
  }, [venueId, t]);
  useEffect(() => void load(), [load]);
  const match = async (p: Unmatched) => {
    setError(null);
    try {
      await api("POST", `/v1/venues/${venueId}/payments/${p.id}/match`, { check_id: pick[p.id] });
      await load();
    } catch (e) {
      setError(
        e instanceof ApiCallError && e.code === "over_amount_due"
          ? t("unmatched.overDue", {
              due: money(Number(e.details["amount_due_cents"] ?? 0) as Cents),
            })
          : t("unmatched.failed"),
      );
    }
  };
  if (!data)
    return error ? (
      <p role="alert" className="error">
        {error}
      </p>
    ) : null;
  return (
    <section className="card unmatched" aria-labelledby="unmatched-title">
      <h3 id="unmatched-title">{t("unmatched.title", { count: data.payments.length })}</h3>
      {data.payments.length === 0 && <p className="muted">{t("unmatched.none")}</p>}
      <ul className="tips-shares">
        {data.payments.map((p) => (
          <li key={p.id} className="row">
            <span>
              {money(p.amount_cents as Cents)} · {p.card_brand ?? ""} ··{p.card_last4 ?? ""} ·{" "}
              {time(p.at, timeZone)}
            </span>
            <span className="actions">
              <select
                aria-label={t("unmatched.pick")}
                value={pick[p.id] ?? ""}
                onChange={(e) => setPick({ ...pick, [p.id]: e.target.value })}
              >
                <option value="">{t("drawer.pick")}</option>
                {data.checks.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label} · {money(k.amount_due_cents as Cents)}
                  </option>
                ))}
              </select>
              <button type="button" disabled={!pick[p.id]} onClick={() => void match(p)}>
                {t("unmatched.match")}
              </button>
            </span>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
