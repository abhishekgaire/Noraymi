import { useState, type FormEvent } from "react";
import { outsideCardNoteOk } from "@west4/rules";
import { api, ApiCallError } from "../api.js";
import { useT } from "../i18n.js";
import { useModuleOn } from "../useModule.js";

/**
 * Paid on an outside card machine (F-10; D126; spec 07 · Outside card machine): staff charge the
 * venue's own machine first, then record the amount, the tip and, if they like, the last 4 or the
 * approval code here. Never the card number: a long run of digits is refused on screen and by the
 * server. Shows only while the venue's switch is on.
 */
const toCents = (text: string): number | null => {
  const m = /^\s*\$?(\d+)(?:\.(\d{1,2}))?\s*$/.exec(text);
  return m ? Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0")) : null;
};
const newKey = () => `outside-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export function OutsideCardPanel({
  venueId,
  checkId,
  dueCents,
  shareId,
  payUrl,
  onTaken,
}: {
  venueId: string;
  checkId: string;
  dueCents: number;
  shareId?: string | null;
  /** A bar tab's own pay route, which closes the tab. */
  payUrl?: string;
  onTaken: () => void;
}) {
  const { t, money } = useT();
  const on = useModuleOn("outside_card");
  const [amount, setAmount] = useState(() => (dueCents / 100).toFixed(2));
  const [tip, setTip] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!on) return null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const amountCents = toCents(amount);
    const tipCents = tip.trim() === "" ? 0 : toCents(tip);
    if (amountCents === null || amountCents <= 0 || tipCents === null) {
      setError(t("outsideCard.failed"));
      return;
    }
    if (!outsideCardNoteOk(note.trim())) {
      setError(t("outsideCard.cardNumber"));
      return;
    }
    setBusy(true);
    try {
      await api(
        "POST",
        payUrl ?? `/v1/venues/${venueId}/checks/${checkId}/payments`,
        {
          method: "outside_card",
          amount_cents: amountCents,
          tip_cents: tipCents,
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(shareId && !payUrl ? { share_id: shareId } : {}),
        },
        { idempotencyKey: newKey() },
      );
      setDone(t("outsideCard.recorded", { amount: money((amountCents + tipCents) as never) }));
      onTaken();
    } catch (err) {
      setError(
        err instanceof ApiCallError && err.details["reason"] === "card_number"
          ? t("outsideCard.cardNumber")
          : err instanceof ApiCallError && err.details["reason"] === "over"
            ? t("outsideCard.over")
            : t("outsideCard.failed"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="outside-card"
      aria-label={t("outsideCard.title")}
      onSubmit={(e) => void submit(e)}
    >
      <h3>{t("outsideCard.title")}</h3>
      <p className="small muted">{t("outsideCard.hint")}</p>
      <div className="invite-fields">
        <label>
          <span>{t("outsideCard.amount")}</span>
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label>
          <span>{t("outsideCard.tip")}</span>
          <input inputMode="decimal" value={tip} onChange={(e) => setTip(e.target.value)} />
        </label>
        <label>
          <span>{t("outsideCard.note")}</span>
          <input
            maxLength={40}
            autoComplete="off"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <span className="small muted">{t("outsideCard.noteHint")}</span>
        </label>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {done && (
        <p className="ok" role="status">
          {done}
        </p>
      )}
      <button type="submit" className="primary" disabled={busy}>
        {t("outsideCard.record")}
      </button>
    </form>
  );
}
