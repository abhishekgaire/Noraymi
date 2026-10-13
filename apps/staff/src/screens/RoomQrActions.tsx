import { useState } from "react";
import { api, type ApiCallError } from "../api.js";
import { useT } from "../i18n.js";
import { useModuleOn } from "../useModule.js";

/**
 * Reprint QR and Email it again (F-07; D124; screens N3): the room's current join QR on the front
 * desk's receipt printer, or emailed to the host when their email is known. Only while Ordering
 * from the room is on; on DeskRoom, the bar POS's rooms list and the staff phone's room.
 */
export function RoomQrActions({ venueId, sessionId }: { venueId: string; sessionId: string }) {
  const { t } = useT();
  const on = useModuleOn("room_ordering");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  if (!on) return null;

  const send = async (what: "print" | "email") => {
    setBusy(true);
    setNote(null);
    try {
      const r = await api<{ printed: boolean; emailed: string | null }>(
        "POST",
        `/v1/venues/${venueId}/sessions/${sessionId}/qr`,
        what === "print" ? { print: true } : { print: false, email: true },
      );
      setNote(
        what === "print"
          ? { text: r.printed ? t("roomQr.printed") : t("roomQr.failed"), error: !r.printed }
          : r.emailed
            ? { text: t("roomQr.emailed", { email: r.emailed }), error: false }
            : { text: t("roomQr.noEmail"), error: true },
      );
    } catch (e) {
      setNote({ text: (e as ApiCallError)?.message ?? t("roomQr.failed"), error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={() => void send("print")}
      >
        {t("roomQr.reprint")}
      </button>
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={() => void send("email")}
      >
        {t("roomQr.emailAgain")}
      </button>
      {note && (
        <span className={note.error ? "small error" : "small"} role="status">
          {note.text}
        </span>
      )}
    </>
  );
}
