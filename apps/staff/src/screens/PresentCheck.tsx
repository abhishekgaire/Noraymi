import { useState } from "react";
import { api, type ApiCallError } from "../api.js";
import { useT } from "../i18n.js";

/**
 * Present the check (M4-08; Payment flows · Room close-out step 1): it
 * finalizes the room's check and closes ordering from the room. While an
 * order rings or waits at the bar it's refused, and each one is listed first
 * ("2 × Margarita · Peach is ringing at the bar · accept or cancel it
 * first"). A presented check can be reopened by a manager.
 */
interface Blocker {
  readonly order_id: string;
  readonly status: "ringing" | "held";
  readonly items: string;
}

export function PresentCheck({
  venueId,
  checkId,
  status,
  canReopen,
  onDone,
}: {
  venueId: string;
  checkId: string;
  status: string;
  canReopen: boolean;
  onDone: () => void;
}) {
  const { t } = useT();
  const [blockers, setBlockers] = useState<readonly Blocker[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (what: "present" | "reopen") => {
    setBusy(true);
    setError(null);
    setMessage(null);
    setBlockers([]);
    try {
      await api("POST", `/v1/venues/${venueId}/checks/${checkId}/${what}`);
      setMessage(t(what === "present" ? "present.done" : "present.reopened"));
      onDone();
    } catch (e) {
      const err = e as ApiCallError;
      const orders = (err?.details as { orders?: Blocker[] } | undefined)?.orders;
      if (err?.code === "orders_open" && orders) setBlockers(orders);
      else setError(t("present.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="present" aria-label={t("present.button")}>
      {status === "open" || status === "reopened" ? (
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => void act("present")}
        >
          {t("present.button")}
        </button>
      ) : (
        canReopen &&
        (status === "finalized" || status === "partly_paid") && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void act("reopen")}
          >
            {t("present.reopen")}
          </button>
        )
      )}
      {blockers.length > 0 && (
        <ul className="blocked" role="alert">
          {blockers.map((b) => (
            <li key={b.order_id}>
              {t(b.status === "held" ? "present.blocked.held" : "present.blocked.ringing", {
                items: b.items,
              })}
            </li>
          ))}
        </ul>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
