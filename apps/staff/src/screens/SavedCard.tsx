import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ApiCallError } from "../api.js";
import { useT } from "../i18n.js";

/**
 * Charge the saved card on a reopened tab (M6-12; Payment flows · Bar tab
 * with a growing hold, step 9; screens Rail note 3): the card saved from the
 * tab's first tap, charged off-session for what's due. Nothing is charged
 * until the guest taps Yes on the bar reader, or a manager approves on their
 * own phone ("Waiting for Andy"). No on the reader, Cancel or a manager's No
 * charges nothing, and the tab takes drinks again.
 */
interface Reader {
  readonly id: string;
  readonly station: string;
  readonly registered: boolean;
}
interface Payment {
  readonly id: string;
  readonly state:
    "waiting_guest" | "waiting" | "unknown" | "paid" | "declined" | "canceled" | "failed";
  readonly approval: { readonly status: string; readonly waiting_for: string } | null;
  readonly reader_confirm: { readonly state: string } | null;
}

const newKey = () => `saved-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export function SavedCard({
  venueId,
  tabId,
  card,
  dueCents,
  paymentId,
  onPaid,
  onChanged,
}: {
  venueId: string;
  tabId: string;
  /** "Visa ··4417": the card saved from the first tap. */
  card: string;
  dueCents: number;
  /** A charge already waiting, so the screen picks it up after a reload. */
  paymentId: string | null;
  onPaid: () => void;
  onChanged: () => void;
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
      // check-status reads the guest's answer on the bar reader now.
      const p = await api<Payment>("POST", `/v1/venues/${venueId}/payments/${id}/check-status`);
      setPayment(p);
      if (!["waiting_guest", "waiting", "unknown"].includes(p.state)) {
        clearInterval(timer.current);
        onChanged();
        if (p.state === "paid") onPaid();
      }
      return p;
    },
    [venueId, onPaid, onChanged],
  );
  const follow = useCallback(
    (id: string) => {
      clearInterval(timer.current);
      timer.current = setInterval(() => void read(id).catch(() => undefined), 1000);
    },
    [read],
  );
  useEffect(() => {
    if (paymentId && !payment)
      void read(paymentId).then(
        (p) => {
          if (["waiting_guest", "waiting", "unknown"].includes(p.state)) follow(paymentId);
        },
        () => undefined,
      );
  }, [paymentId, payment, read, follow]);
  useEffect(() => () => clearInterval(timer.current), []);

  const act = async (call: () => Promise<void>) => {
    setBusy(true);
    setFailed(false);
    try {
      await call();
    } catch (e) {
      // Taken by someone else meanwhile: read what's there.
      if ((e as ApiCallError)?.code === "in_progress") onChanged();
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const barReader = async () => {
    const list = await api<{ readers: Reader[] }>("GET", `/v1/venues/${venueId}/readers`);
    const ready = list.readers.filter((r) => r.registered);
    return (ready.find((r) => r.station === "bar") ?? ready[0])?.id ?? null;
  };
  const askReader = () =>
    act(async () => {
      const p = await api<Payment>(
        "POST",
        `/v1/venues/${venueId}/tabs/${tabId}/charge-saved-card`,
        { amount_cents: dueCents, reader_id: await barReader() },
        { idempotencyKey: newKey() },
      );
      setPayment(p);
      onChanged();
      follow(p.id);
    });
  const askManager = () =>
    act(async () => {
      if (payment && payment.state === "waiting_guest") {
        await api(
          "POST",
          `/v1/venues/${venueId}/payments/${payment.id}/approval`,
          { reason: reason.trim() },
          { idempotencyKey: newKey() },
        );
        setAsking(false);
        await read(payment.id);
        follow(payment.id);
        return;
      }
      const r = await api<{ payment_id: string }>(
        "POST",
        `/v1/venues/${venueId}/tabs/${tabId}/charge-saved-card`,
        { amount_cents: dueCents, reason: reason.trim() },
        { idempotencyKey: newKey() },
      );
      setAsking(false);
      onChanged();
      await read(r.payment_id);
      follow(r.payment_id);
    });
  const cancel = () =>
    act(async () => {
      await api("POST", `/v1/venues/${venueId}/payments/${payment!.id}/cancel`, undefined, {
        idempotencyKey: newKey(),
      });
      await read(payment!.id);
    });

  const waiting = payment?.state === "waiting_guest";
  const approval = payment?.approval;
  const confirm = payment?.reader_confirm?.state ?? null;
  const ended = !payment || payment.state === "canceled" || payment.state === "declined";
  return (
    <section className="saved-card" aria-label={t("savedCard.title")}>
      <h3>
        {t("savedCard.title")}
        {" · "}
        <span data-guest-text>{card}</span>
      </h3>
      {ended && dueCents > 0 && !asking && (
        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void askReader()}
          >
            {t("savedCard.askReader")}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => setAsking(true)}
          >
            {t("pay.onFile.ask")}
          </button>
        </div>
      )}
      {waiting && approval?.status !== "pending" && (
        <p role="status">
          {confirm === "asking"
            ? t("savedCard.waiting")
            : confirm === "offline"
              ? t("savedCard.offline")
              : t("savedCard.goAhead")}
          {" · "}
          <button type="button" className="link" disabled={busy} onClick={() => void cancel()}>
            {t("pay.cancel")}
          </button>
        </p>
      )}
      {waiting && approval?.status !== "pending" && !asking && (
        <button type="button" className="secondary" disabled={busy} onClick={() => setAsking(true)}>
          {t("pay.onFile.ask")}
        </button>
      )}
      {asking && (
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
          <div className="actions">
            <button type="submit" className="primary" disabled={busy || !reason.trim()}>
              {t("pay.onFile.send")}
            </button>
            <button type="button" className="link" onClick={() => setAsking(false)}>
              {t("pay.cancel")}
            </button>
          </div>
        </form>
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
          {approval?.status === "declined"
            ? t("pay.onFile.approvalDeclined")
            : confirm === "no"
              ? t("savedCard.no")
              : confirm === "timed_out"
                ? t("closeTab.noAnswer")
                : t("pay.canceled")}
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
