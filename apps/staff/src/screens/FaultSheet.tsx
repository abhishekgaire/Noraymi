import { useState, type FormEvent } from "react";
import { api } from "../api.js";
import { useT } from "../i18n.js";

/**
 * N14 Report a fault (M2-16): the note, and whether to take the room out of
 * service, pause the clock (always an approval) or comp 15 minutes of room
 * time (reason-only up to the limit, otherwise an approval). Pausing and
 * comping need guests in the room.
 */
export interface FaultTarget {
  readonly roomId: string;
  readonly roomName: string;
  readonly hasSession: boolean;
}

interface Pending {
  readonly status: "approval_pending";
  readonly waiting_for: { readonly name: string };
}
interface Answer {
  readonly pause?: Pending;
  readonly comp?: Pending | { readonly status: "added"; readonly amount_cents: number };
}

export function FaultSheet({
  venueId,
  target,
  onClose,
  onLogged,
}: {
  venueId: string;
  target: FaultTarget;
  onClose: () => void;
  onLogged: (words: string) => void;
}) {
  const { t, money } = useT();
  const [text, setText] = useState("");
  const [outOfService, setOutOfService] = useState(false);
  const [pause, setPause] = useState(false);
  const [comp, setComp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError(false);
    try {
      const answer = await api<Answer>(
        "POST",
        `/v1/venues/${venueId}/rooms/${target.roomId}/faults`,
        {
          text: text.trim(),
          ...(outOfService ? { out_of_service: true } : {}),
          ...(pause ? { pause_clock: true } : {}),
          ...(comp ? { comp_minutes: 15 } : {}),
        },
      );
      const words = [t("fault.logged", { room: target.roomName })];
      const waiting =
        answer.pause ?? (answer.comp?.status === "approval_pending" ? answer.comp : null);
      if (waiting) words.push(t("approvals.waitingFor", { name: waiting.waiting_for.name }));
      if (answer.comp?.status === "added")
        words.push(t("fault.compAdded", { amount: money(answer.comp.amount_cents as never) }));
      onLogged(words.join(" · "));
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  const title = t("fault.title", { room: target.roomName });
  return (
    <form className="sheet" role="dialog" aria-label={title} onSubmit={(e) => void submit(e)}>
      <h2>{title}</h2>
      <label>
        {t("fault.what")}
        <textarea value={text} maxLength={500} required onChange={(e) => setText(e.target.value)} />
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={outOfService}
          onChange={(e) => setOutOfService(e.target.checked)}
        />
        {t("fault.outOfService")}
      </label>
      {target.hasSession && (
        <>
          <label className="check">
            <input type="checkbox" checked={pause} onChange={(e) => setPause(e.target.checked)} />
            {t("fault.pause")} <span className="muted small">{t("fault.pauseHint")}</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={comp} onChange={(e) => setComp(e.target.checked)} />
            {t("fault.comp")}
          </label>
        </>
      )}
      {error && (
        <p role="alert" className="error">
          {t("fault.failed")}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="primary" disabled={busy || !text.trim()}>
          {t("fault.save")}
        </button>
        <button type="button" onClick={onClose}>
          {t("checkIn.cancel")}
        </button>
      </div>
    </form>
  );
}
