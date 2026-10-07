import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { useT } from "../i18n.js";

/**
 * The break-glass card on Close the night (M8-06; spec 09 · Break-glass card; screens N29, Night
 * note 8): who's ready for Tap to Pay (both go-live checks confirmed in Admin → Payments), the
 * letter-size card as a PDF (English, then Spanish) to print ahead of time and keep at each desk,
 * and a short version for the front-desk receipt printer.
 */
interface Card {
  readonly ready: readonly string[];
  readonly not_ready: readonly string[];
}

export function BreakGlassCard({ venueId }: { venueId: string }) {
  const { t } = useT();
  const [card, setCard] = useState<Card | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setCard(await api<Card>("GET", `/v1/venues/${venueId}/break-glass-card`));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [venueId]);
  useEffect(() => void load(), [load]);

  const savePdf = async () => {
    setNotice(t("breakGlass.opening"));
    setBusy(true);
    try {
      const r = await api<{ pdf: string; filename: string }>(
        "GET",
        `/v1/venues/${venueId}/break-glass-card/pdf`,
      );
      const bytes = Uint8Array.from(atob(r.pdf), (ch) => ch.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = r.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setNotice(t("breakGlass.saved"));
    } catch {
      setNotice(t("breakGlass.openFailed"));
    } finally {
      setBusy(false);
    }
  };
  const printShort = async () => {
    setNotice(null);
    setBusy(true);
    try {
      await api("POST", `/v1/venues/${venueId}/break-glass-card/print`, {});
      setNotice(t("report.printed"));
    } catch {
      setNotice(t("report.printFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card break-glass" aria-labelledby="break-glass-title">
      <h2 id="break-glass-title">{t("breakGlass.title")}</h2>
      <p className="small">{t("breakGlass.hint")}</p>
      {failed ? (
        <p role="alert" className="error">
          {t("breakGlass.error")}
        </p>
      ) : !card ? (
        <p className="muted">{t("breakGlass.loading")}</p>
      ) : card.ready.length === 0 ? (
        <p className="notice">{t("breakGlass.noneReady")}</p>
      ) : (
        <p>{t("breakGlass.ready", { names: card.ready.join(", ") })}</p>
      )}
      {notice && (
        <p role="status" className="small">
          {notice}
        </p>
      )}
      <div className="actions">
        <button type="button" className="secondary" disabled={busy} onClick={() => void savePdf()}>
          {t("breakGlass.printLetter")}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => void printShort()}
        >
          {t("breakGlass.printShort")}
        </button>
      </div>
    </section>
  );
}
