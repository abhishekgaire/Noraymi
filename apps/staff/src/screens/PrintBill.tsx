import { useState } from "react";
import { api, type ApiCallError } from "../api.js";
import { useT } from "../i18n.js";

/**
 * Print the bill (P-01; Payment flows · Room close-out; spec 09 · The bill before paying): the check
 * as it stands, on this station's receipt printer, for the guest to look over before paying. On a
 * room's close-out (before and after Present the check) and on a bar tab. Every amount comes from
 * the server; a printer that's offline shows up in the usual failed-print list with Reprint.
 */
export function PrintBill({ venueId, checkId }: { venueId: string; checkId: string }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);

  const print = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await api<{ reprint_n: number }>(
        "POST",
        `/v1/venues/${venueId}/checks/${checkId}/bill`,
        {},
      );
      setNote({
        text:
          r.reprint_n > 0 ? t("printBill.reprinted", { n: r.reprint_n }) : t("printBill.printed"),
        error: false,
      });
    } catch (e) {
      setNote({ text: (e as ApiCallError)?.message ?? t("printBill.failed"), error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="secondary print-bill"
        disabled={busy}
        onClick={() => void print()}
      >
        {t("printBill.button")}
      </button>
      {note && (
        <span className={note.error ? "small error" : "small"} role="status">
          {note.text}
        </span>
      )}
    </>
  );
}
