import { useState, type FormEvent } from "react";
import { api, ApiCallError } from "../api.js";
import { useT } from "../i18n.js";
import { useModuleOn } from "../useModule.js";

/**
 * Add a missed sale (P-19; Money rules 16): a manager marks a bar tab opened tonight as a sale an
 * earlier night missed, with the night it came from and a reason (the server refuses tonight, a later
 * date or no reason), approved per the venue's setting. The tab's lines count on tonight's date; the
 * Z report shows the night it came from. Remove takes the mark off while the tab is open. The button
 * shows only while the venue's switch is on and to people who can ask for a refund (owners and
 * managers); a mark already standing always shows.
 */
export interface MissedSaleView {
  readonly from_date: string;
  readonly reason: string;
}
export interface PendingMissedSale {
  readonly waiting_for: string;
  readonly from_date: string;
}

export function MissedSalePanel(props: {
  venueId: string;
  checkId: string;
  missed: MissedSaleView | null;
  pending: PendingMissedSale | null;
  /** Whether the tab is still open: the mark changes only then (before payment). */
  open: boolean;
  /** Owners and managers (refunds.request): only they add or remove one. */
  canChange: boolean;
  onDone: () => void;
}) {
  const { t } = useT();
  const on = useModuleOn("missed_sale");
  const [editing, setEditing] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!props.missed && !props.pending && !(on && props.canChange)) return null;

  const failed = (err: unknown) => {
    if (err instanceof ApiCallError && err.details["reason"] === "date_not_earlier")
      return t("missedSale.dateNotEarlier");
    if (err instanceof ApiCallError && err.details["reason"] === "reason_missing")
      return t("missedSale.reasonMissing");
    return (err as Error)?.message || t("missedSale.failed");
  };

  const ask = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!fromDate) return setError(t("missedSale.dateMissing"));
    if (!reason.trim()) return setError(t("missedSale.reasonMissing"));
    setBusy(true);
    try {
      const answer = await api<{
        status: string;
        waiting_for?: { name: string } | null;
        decided_with?: string;
      }>("POST", `/v1/venues/${props.venueId}/checks/${props.checkId}/missed-sale`, {
        from_date: fromDate,
        reason: reason.trim(),
      });
      setMessage(
        answer.status === "approved"
          ? t("missedSale.given")
          : answer.decided_with === "pin"
            ? t("approvals.pin.needs")
            : answer.waiting_for
              ? t("fix.waiting", { name: answer.waiting_for.name })
              : t("missedSale.given"),
      );
      setEditing(false);
      setFromDate("");
      setReason("");
      props.onDone();
    } catch (err) {
      setError(failed(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setError(null);
    setBusy(true);
    try {
      await api("POST", `/v1/venues/${props.venueId}/checks/${props.checkId}/missed-sale/remove`);
      setMessage(t("missedSale.removed"));
      props.onDone();
    } catch (err) {
      setError(failed(err));
    } finally {
      setBusy(false);
    }
  };

  if (!props.missed && !props.pending && !editing && !message && !error)
    return props.open ? (
      <button type="button" className="secondary missed-sale-open" onClick={() => setEditing(true)}>
        {t("missedSale.open")}
      </button>
    ) : null;
  return (
    <section className="fix-panel missed-sale-panel" aria-label={t("missedSale.title")}>
      <h3>{t("missedSale.title")}</h3>
      {message && (
        <p className="small" role="status">
          {message}
        </p>
      )}
      {props.missed ? (
        <p className="fix-line" data-testid="missed-sale-standing">
          <span>
            {t("missedSale.standing", {
              date: props.missed.from_date,
              reason: props.missed.reason,
            })}
          </span>{" "}
          {props.open && props.canChange && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void remove()}
            >
              {t("missedSale.remove")}
            </button>
          )}
        </p>
      ) : props.pending ? (
        <p className="muted" data-testid="missed-sale-waiting">
          {t("fix.waiting", { name: props.pending.waiting_for })}
        </p>
      ) : (
        props.open &&
        on &&
        props.canChange &&
        !editing && (
          <button type="button" className="secondary" onClick={() => setEditing(true)}>
            {t("missedSale.open")}
          </button>
        )
      )}
      {editing && !props.missed && !props.pending && props.open && (
        <form className="invite-form" onSubmit={(e) => void ask(e)} noValidate>
          <p className="small">{t("missedSale.hint")}</p>
          <div className="invite-fields">
            <label>
              <span>{t("missedSale.fromDate")}</span>
              <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            </label>
            <label>
              <span>{t("missedSale.reason")}</span>
              <input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
            </label>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {t("missedSale.ask")}
            </button>
            <button type="button" className="secondary" onClick={() => setEditing(false)}>
              {t("missedSale.back")}
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
