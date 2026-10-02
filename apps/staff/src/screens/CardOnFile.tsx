import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { useT } from "../i18n.js";

/**
 * Card on file at close-out (M4-17; Payment flows · Room close-out; screens
 * N8, DeskRoom note 2): the deposit's card, for what's due. The payment waits
 * for the guest ("Waiting for Marcus to confirm on their phone · Cancel"), who
 * confirms from the bill or the booking link; if they've left, staff ask a
 * manager with a reason and see "Waiting for Andy". Then Paid, or "Declined ·
 * try another card or cash" (the guest is texted a pay link).
 */
export interface OnFile {
  readonly brand: string;
  readonly last4: string;
  readonly guest_name: string | null;
  /** A card-on-file payment already waiting, so the screen picks it up again after a reload. */
  readonly payment_id: string | null;
}
interface Payment {
  readonly id: string;
  readonly state:
    "waiting_guest" | "waiting" | "unknown" | "paid" | "declined" | "canceled" | "failed";
  readonly approval: { readonly status: string; readonly waiting_for: string } | null;
}

const BRANDS: Record<string, string> = {
  amex: "Amex",
  visa: "Visa",
  mastercard: "Mastercard",
  discover: "Discover",
};
const newKey = () => `onfile-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export function CardOnFile({
  venueId,
  checkId,
  dueCents,
  card,
  onDone,
  onStarted,
}: {
  venueId: string;
  checkId: string;
  dueCents: number;
  card: OnFile;
  onDone: () => void;
  /** The payment now waiting, so the screen can read it if the room is released first. */
  onStarted?: (paymentId: string) => void;
}) {
  const { t } = useT();
  const [payment, setPayment] = useState<Payment | null>(null);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const read = useCallback(
    async (id: string) => {
      const p = await api<Payment>("GET", `/v1/venues/${venueId}/payments/${id}`);
      setPayment(p);
      if (!["waiting_guest", "waiting", "unknown"].includes(p.state)) {
        clearInterval(timer.current);
        if (p.state === "paid") onDone();
      }
      return p;
    },
    [venueId, onDone],
  );
  const follow = useCallback(
    (id: string) => {
      clearInterval(timer.current);
      timer.current = setInterval(() => void read(id).catch(() => undefined), 2000);
    },
    [read],
  );
  useEffect(() => {
    if (card.payment_id && !payment) {
      void read(card.payment_id).then(
        () => follow(card.payment_id!),
        () => undefined,
      );
    }
  }, [card.payment_id, payment, read, follow]);
  useEffect(() => () => clearInterval(timer.current), []);

  const act = async (call: () => Promise<unknown>) => {
    setBusy(true);
    setFailed(false);
    try {
      await call();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const start = () =>
    act(async () => {
      const p = await api<Payment>(
        "POST",
        `/v1/venues/${venueId}/checks/${checkId}/payments`,
        { method: "card_on_file", amount_cents: dueCents },
        { idempotencyKey: newKey() },
      );
      setPayment(p);
      onStarted?.(p.id);
      follow(p.id);
    });
  const askManager = () =>
    act(async () => {
      await api(
        "POST",
        `/v1/venues/${venueId}/payments/${payment!.id}/approval`,
        { reason: reason.trim() },
        { idempotencyKey: newKey() },
      );
      setAsking(false);
      await read(payment!.id);
      follow(payment!.id);
    });
  const cancel = () =>
    act(async () => {
      await api("POST", `/v1/venues/${venueId}/payments/${payment!.id}/cancel`, undefined, {
        idempotencyKey: newKey(),
      });
      await read(payment!.id);
    });

  const label = t("pay.onFile.button", {
    brand: BRANDS[card.brand] ?? card.brand,
    last4: card.last4,
  });
  const waiting = payment?.state === "waiting_guest";
  const approval = payment?.approval;
  if (dueCents <= 0 && !payment) return null;
  return (
    <section className="card-on-file" aria-label={label}>
      <h3>{label}</h3>
      {(!payment || payment.state === "canceled" || payment.state === "declined") &&
        dueCents > 0 && (
          <button type="button" className="primary" disabled={busy} onClick={() => void start()}>
            {label}
          </button>
        )}
      {waiting && approval?.status !== "pending" && (
        <>
          <p role="status">
            {t("pay.onFile.waiting", { name: card.guest_name ?? "" })}
            {" · "}
            <button type="button" className="link" disabled={busy} onClick={() => void cancel()}>
              {t("pay.cancel")}
            </button>
          </p>
          {asking ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void askManager();
              }}
            >
              <label>
                <span>{t("pay.onFile.reason")}</span>
                <input value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
              <button type="submit" disabled={busy || !reason.trim()}>
                {t("pay.onFile.send")}
              </button>
            </form>
          ) : (
            <button type="button" disabled={busy} onClick={() => setAsking(true)}>
              {t("pay.onFile.ask")}
            </button>
          )}
        </>
      )}
      {waiting && approval?.status === "pending" && (
        <p role="status">
          {t("approvals.waitingFor", { name: approval.waiting_for })}
          {" · "}
          <button type="button" className="link" disabled={busy} onClick={() => void cancel()}>
            {t("pay.cancel")}
          </button>
        </p>
      )}
      {(payment?.state === "waiting" || payment?.state === "unknown") && (
        <p role="status">{t("pay.unknown")}</p>
      )}
      {payment?.state === "paid" && <p role="status">{t("pay.paid")}</p>}
      {payment?.state === "declined" && <p role="alert">{t("pay.declined")}</p>}
      {payment?.state === "canceled" && (
        <p role="status">
          {approval?.status === "declined" ? t("pay.onFile.approvalDeclined") : t("pay.canceled")}
        </p>
      )}
      {failed && (
        <p className="error" role="alert">
          {t("pay.failed")}
        </p>
      )}
    </section>
  );
}
