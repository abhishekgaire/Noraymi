import { useState, type FormEvent } from "react";
import { api } from "../api.js";
import { useT } from "../i18n.js";

/**
 * Step 4 of close-out (M4-20; Payment flows · Room close-out; screens N21):
 * after Paid, Text, Email, Print or No receipt; then "Room 9 goes to cleaning".
 * Each choice sends the same receipt (M4-19).
 */
export function ReceiptStep({
  venueId,
  checkId,
  roomName,
  doneText,
}: {
  venueId: string;
  checkId: string;
  roomName: string;
  /** What shows once the receipt is sent (a bar tab: "Tab closed"); a room goes to cleaning. */
  doneText?: string;
}) {
  const { t } = useT();
  const [asking, setAsking] = useState<"text" | "email" | null>(null);
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [finished, setFinished] = useState(false);

  const send = async (body: object | null) => {
    setBusy(true);
    setFailed(false);
    try {
      if (body)
        await api("POST", `/v1/venues/${venueId}/checks/${checkId}/receipts`, body, {
          idempotencyKey: `receipt-${checkId}-${Date.now()}`,
        });
      setFinished(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = to.trim();
    if (asking === "text") {
      const digits = value.replace(/\D/g, "");
      void send({ channel: "text", to: digits.length === 10 ? `+1${digits}` : `+${digits}` });
    } else void send({ channel: "email", to: value });
  };

  if (finished)
    return (
      <p className="notice" role="status">
        {doneText ?? t("closeOut.cleaning", { room: roomName })}
      </p>
    );
  return (
    <section className="receipt-step" aria-label={t("closeOut.receipt")}>
      <h3>{t("closeOut.receipt")}</h3>
      <div className="actions">
        <button type="button" className="primary" disabled={busy} onClick={() => setAsking("text")}>
          {t("closeOut.text")}
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => setAsking("email")}
        >
          {t("closeOut.email")}
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => void send({ channel: "print" })}
        >
          {t("closeOut.print")}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={() => void send(null)}>
          {t("closeOut.none")}
        </button>
      </div>
      {asking && (
        <form onSubmit={submit}>
          <label>
            <span>{asking === "text" ? t("closeOut.phone") : t("closeOut.emailAddress")}</span>
            <input
              type={asking === "text" ? "tel" : "email"}
              inputMode={asking === "text" ? "tel" : "email"}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <button type="submit" className="primary" disabled={busy || !to.trim()}>
            {t("closeOut.send")}
          </button>
        </form>
      )}
      {failed && (
        <p className="error" role="alert">
          {t("closeOut.failed")}
        </p>
      )}
    </section>
  );
}
