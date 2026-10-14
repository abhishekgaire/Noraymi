import { useState, type FormEvent } from "react";
import { api, type ApiCallError } from "../api.js";
import { useT } from "../i18n.js";
import { useModuleOn } from "../useModule.js";

/**
 * A % or $ discount on a whole check (P-02; Money rules 7): a room's check or a bar tab, a percent or
 * an amount, and a reason. It comes off room time and drinks before tax, and the gratuity is figured
 * on what's left. Within the reason-only limit it goes on at once; over it, the check reads
 * "Waiting for Andy" until it's approved (on the approver's phone or by PIN, the venue's setting).
 * Remove takes it off while the check is open. Shows only while the venue's switch is on, except the
 * Remove button, so a discount is never stuck on a check.
 */
export interface CheckDiscountView {
  readonly mode: "pct" | "amount";
  readonly pct: string | null;
  readonly amount_cents: number | null;
  readonly reason: string;
  readonly cents: number;
}
export interface PendingDiscount {
  readonly waiting_for: string;
  readonly cents: number;
}

const toCents = (text: string): number | null => {
  const m = /^\s*\$?(\d+)(?:\.(\d{1,2}))?\s*$/.exec(text);
  return m ? Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0")) : null;
};
/** A percent with at most two decimals, from 0.01 to 100. */
const toPct = (text: string): number | null => {
  const m = /^\s*(\d{1,3})(?:\.(\d{1,2}))?\s*%?\s*$/.exec(text);
  if (!m) return null;
  const hundredths = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return hundredths >= 1 && hundredths <= 10_000 ? hundredths / 100 : null;
};
const REASONS = [
  "discount.reason.regular",
  "discount.reason.service",
  "discount.reason.staff",
] as const;

export function DiscountPanel(props: {
  venueId: string;
  checkId: string;
  discount: CheckDiscountView | null;
  pending: PendingDiscount | null;
  /** Whether the check is still open: a discount changes only then (before payment). */
  open: boolean;
  onDone: () => void;
}) {
  const { t, money } = useT();
  const on = useModuleOn("check_discount");
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<"pct" | "amount">("pct");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!on && !props.discount) return null;

  const what = (d: { mode: "pct" | "amount"; pct: string | null; amount_cents: number | null }) =>
    d.mode === "pct" ? `${d.pct ?? ""}%` : money((d.amount_cents ?? 0) as never);

  const give = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const pct = mode === "pct" ? toPct(value) : null;
    const amount = mode === "amount" ? toCents(value) : null;
    if (mode === "pct" && pct === null) return setError(t("discount.pctBad"));
    if (mode === "amount" && (amount === null || amount <= 0))
      return setError(t("discount.amountBad"));
    if (!reason.trim()) return;
    setBusy(true);
    try {
      const answer = await api<{
        status: string;
        discount_cents?: number;
        waiting_for?: { name: string } | null;
      }>("POST", `/v1/venues/${props.venueId}/checks/${props.checkId}/discount`, {
        ...(mode === "pct" ? { mode, pct } : { mode, amount_cents: amount }),
        reason: reason.trim(),
      });
      setMessage(
        answer.status === "added"
          ? t("discount.given", { amount: money((answer.discount_cents ?? 0) as never) })
          : answer.waiting_for
            ? t("fix.waiting", { name: answer.waiting_for.name })
            : t("discount.given", { amount: "" }),
      );
      setEditing(false);
      setValue("");
      setReason("");
      props.onDone();
    } catch (err) {
      setError((err as ApiCallError)?.message ?? t("discount.failed"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setError(null);
    setBusy(true);
    try {
      await api("POST", `/v1/venues/${props.venueId}/checks/${props.checkId}/discount/remove`);
      setMessage(t("discount.removed"));
      props.onDone();
    } catch (err) {
      setError((err as ApiCallError)?.message ?? t("discount.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="fix-panel discount-panel" aria-label={t("discount.title")}>
      <h3>{t("discount.title")}</h3>
      {message && (
        <p className="small" role="status">
          {message}
        </p>
      )}
      {props.discount ? (
        <p className="fix-line" data-testid="discount-standing">
          <span data-guest-text>
            {t("discount.standing", {
              what: what(props.discount),
              amount: `−${money(props.discount.cents as never)}`,
              reason: props.discount.reason,
            })}
          </span>{" "}
          {props.open && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void remove()}
            >
              {t("discount.remove")}
            </button>
          )}
        </p>
      ) : props.pending ? (
        <p className="muted" data-testid="discount-waiting">
          {t("fix.waiting", { name: props.pending.waiting_for })}
        </p>
      ) : (
        props.open &&
        on &&
        !editing && (
          <button type="button" className="secondary" onClick={() => setEditing(true)}>
            {t("discount.open")}
          </button>
        )
      )}
      {editing && !props.discount && !props.pending && props.open && (
        <form className="invite-form" onSubmit={(e) => void give(e)}>
          <p className="small">{t("discount.hint")}</p>
          <fieldset className="day-picks">
            <legend>{t("discount.title")}</legend>
            <label className="switch-line">
              <input
                type="radio"
                name="discount-mode"
                checked={mode === "pct"}
                onChange={() => setMode("pct")}
              />
              <span>{t("discount.pct")}</span>
            </label>
            <label className="switch-line">
              <input
                type="radio"
                name="discount-mode"
                checked={mode === "amount"}
                onChange={() => setMode("amount")}
              />
              <span>{t("discount.amount")}</span>
            </label>
          </fieldset>
          <div className="invite-fields">
            <label>
              <span>{mode === "pct" ? t("discount.pctField") : t("discount.amountField")}</span>
              <input
                inputMode="decimal"
                value={value}
                required
                onChange={(e) => setValue(e.target.value)}
              />
            </label>
            <label>
              <span>{t("discount.reason")}</span>
              <input
                value={reason}
                required
                maxLength={300}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          </div>
          <div className="chips" role="group" aria-label={t("discount.reasons")}>
            {REASONS.map((k) => (
              <button
                key={k}
                type="button"
                className="secondary"
                aria-pressed={reason === t(k)}
                onClick={() => setReason(t(k))}
              >
                {t(k)}
              </button>
            ))}
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="actions">
            <button
              type="submit"
              className="primary"
              disabled={busy || !reason.trim() || !value.trim()}
            >
              {t("discount.give")}
            </button>
            <button type="button" className="secondary" onClick={() => setEditing(false)}>
              {t("discount.back")}
            </button>
          </div>
        </form>
      )}
      {error && !editing && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
