import { useCallback, useState } from "react";
import { api, type ApiCallError } from "../api.js";
import { useT } from "../i18n.js";
import { PrintBill } from "./PrintBill.js";

/**
 * Present the check (M4-08; Payment flows · Room close-out step 1): it
 * finalizes the room's check and closes ordering from the room. While an
 * order rings or waits at the bar it's refused, and each one is listed first
 * ("2 × Margarita · Peach is ringing at the bar · accept or cancel it
 * first"), with Accept and Cancel on its line (U-10; D133), each through the
 * order's own route, after which the check is presented again through the same
 * route. A presented check can be reopened by a manager.
 */
interface Blocker {
  readonly order_id: string;
  readonly status: "ringing" | "held";
  readonly items: string;
}

export interface Presenting {
  readonly busy: boolean;
  readonly blockers: readonly Blocker[];
  readonly message: string | null;
  readonly error: string | null;
  /** POST …/present; true once the check is presented. */
  readonly present: () => Promise<boolean>;
  readonly reopen: () => Promise<void>;
  /** Accept or cancel a blocking order through its own route, then present again (U-10). */
  readonly settle: (orderId: string, step: "accept" | "cancel") => Promise<void>;
}

/**
 * The present action, shared by the button, the first payment tap and the board's Present & pay
 * (U-10): every one goes through `POST /checks/:id/present` and its rules, never around them.
 */
export function usePresent(
  venueId: string,
  checkId: string | null,
  onDone: () => void,
): Presenting {
  const { t } = useT();
  const [blockers, setBlockers] = useState<readonly Blocker[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const act = useCallback(
    async (what: "present" | "reopen"): Promise<boolean> => {
      if (!checkId) return false;
      setBusy(true);
      setError(null);
      setMessage(null);
      setBlockers([]);
      try {
        await api("POST", `/v1/venues/${venueId}/checks/${checkId}/${what}`);
        setMessage(t(what === "present" ? "present.done" : "present.reopened"));
        onDone();
        return true;
      } catch (e) {
        const err = e as ApiCallError;
        const orders = (err?.details as { orders?: Blocker[] } | undefined)?.orders;
        if (err?.code === "orders_open" && orders) setBlockers(orders);
        else setError(t("present.failed"));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [venueId, checkId, onDone, t],
  );

  const settle = useCallback(
    async (orderId: string, step: "accept" | "cancel") => {
      setBusy(true);
      setError(null);
      try {
        await api("POST", `/v1/venues/${venueId}/orders/${orderId}/${step}`, {});
      } catch {
        setBusy(false);
        setError(t("present.orderFailed"));
        return;
      }
      setBusy(false);
      await act("present");
    },
    [venueId, act, t],
  );

  const present = useCallback(() => act("present"), [act]);
  const reopen = useCallback(async () => {
    await act("reopen");
  }, [act]);
  return { busy, blockers, message, error, present, reopen, settle };
}

export function PresentCheck({
  venueId,
  checkId,
  status,
  canReopen,
  canSettle,
  presenting,
}: {
  venueId: string;
  checkId: string;
  status: string;
  canReopen: boolean;
  /** Accept and Cancel on a blocking order need orders.accept, as on Bar orders. */
  canSettle: boolean;
  presenting: Presenting;
}) {
  const { t } = useT();
  const { busy, blockers, message, error } = presenting;

  return (
    <section className="present" aria-label={t("present.button")}>
      {status === "open" || status === "reopened" ? (
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => void presenting.present()}
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
            onClick={() => void presenting.reopen()}
          >
            {t("present.reopen")}
          </button>
        )
      )}
      {/* Print the bill (P-01): before and after presenting, until it's paid. */}
      {status !== "paid" && <PrintBill venueId={venueId} checkId={checkId} />}
      {blockers.length > 0 && (
        <ul className="blocked" role="alert">
          {blockers.map((b) => (
            <li key={b.order_id}>
              <span>
                {t(b.status === "held" ? "present.blocked.held" : "present.blocked.ringing", {
                  items: b.items,
                })}
              </span>
              {canSettle && (
                <span className="actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    aria-label={t("present.acceptOrder", { items: b.items })}
                    onClick={() => void presenting.settle(b.order_id, "accept")}
                  >
                    {t("present.accept")}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    aria-label={t("present.cancelOrder", { items: b.items })}
                    onClick={() => void presenting.settle(b.order_id, "cancel")}
                  >
                    {t("present.cancel")}
                  </button>
                </span>
              )}
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
