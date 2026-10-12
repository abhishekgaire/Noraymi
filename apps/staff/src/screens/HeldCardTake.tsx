import { useState, type FormEvent } from "react";
import { api, ApiCallError } from "../api.js";
import { useT } from "../i18n.js";
import { useSheetDialog } from "../layout/Dialog.js";

/**
 * Keep the card behind the bar (O-08; D116): once a walk-in is seated, staff
 * keep the guest's physical card and type the name on it and its last 4
 * digits. No reader and nothing charged; a full card number is never taken
 * (the field takes exactly 4 digits). Skip the card leaves them seated with
 * no card, as Card on the tab's Skip does (D112).
 */
export function HeldCardTake({
  venueId,
  checkId,
  roomName,
  seatedLine,
  onDone,
}: {
  venueId: string;
  checkId: string;
  roomName: string;
  seatedLine: string;
  onDone: (line: string) => void;
}) {
  const { t } = useT();
  const title = t("checkIn.held.title", { room: roomName });
  const dlg = useSheetDialog(title);
  const [name, setName] = useState("");
  const [last4, setLast4] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<"invalid" | "failed" | null>(null);
  const nameOk = name.trim().length > 0 && name.trim().length <= 60 && !/\d/.test(name);
  const last4Ok = /^\d{4}$/.test(last4);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!nameOk || !last4Ok) {
      setProblem("invalid");
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const r = await api<{ held_card: { name: string; last4: string } }>(
        "POST",
        `/v1/venues/${venueId}/checks/${checkId}/held-card`,
        { name: name.trim(), last4 },
      );
      onDone(
        `${seatedLine} · ${t("heldCard.chip", {
          name: r.held_card.name.toUpperCase(),
          last4: r.held_card.last4,
        })}`,
      );
    } catch (err) {
      setProblem(err instanceof ApiCallError && err.status === 400 ? "invalid" : "failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="sheet held-card-take" {...dlg.root} onSubmit={(e) => void save(e)}>
      <h2 {...dlg.title}>{title}</h2>
      <p className="notice" role="status">
        {seatedLine}
      </p>
      <p className="small">{t("checkIn.held.hint")}</p>
      {problem && (
        <p className="error" role="alert">
          {t(problem === "invalid" ? "checkIn.held.invalid" : "checkIn.held.failed")}
        </p>
      )}
      <div className="invite-fields">
        <label>
          <span>{t("checkIn.held.name")}</span>
          <input
            aria-label={t("checkIn.held.name")}
            autoComplete="off"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          <span>{t("checkIn.held.last4")}</span>
          <input
            aria-label={t("checkIn.held.last4")}
            autoComplete="off"
            inputMode="numeric"
            pattern="[0-9]{4}"
            maxLength={4}
            value={last4}
            onChange={(e) => setLast4(e.target.value.replace(/\D/g, "").slice(0, 4))}
          />
        </label>
      </div>
      <div className="row">
        <button type="submit" className="primary" disabled={busy}>
          {t("checkIn.held.save")}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => onDone(`${seatedLine} · ${t("checkIn.held.skipped")}`)}
        >
          {t("checkIn.card.skip")}
        </button>
      </div>
    </form>
  );
}
