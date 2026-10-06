import { useState } from "react";
import { api } from "../api.js";
import { useT } from "../i18n.js";

/**
 * Training mode's [Tap a test card] (M7-04): while a practice payment waits
 * on a simulated reader, the trainee "taps" Stripe's test card, or a declined
 * one, through the API, and the screen then shows the sandbox's real answer.
 * Shown only for a practice payment; the API refuses it outside training.
 */
export function TestCard({ venueId, readerId }: { venueId: string; readerId: string | null }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  if (!readerId) return null;
  const tap = async (declined: boolean) => {
    setBusy(true);
    try {
      await api(
        "POST",
        `/v1/venues/${venueId}/readers/${readerId}/test-card`,
        { declined },
        { idempotencyKey: `test-card-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` },
      );
    } catch {
      // The payment's own state shows what happened; a refused tap leaves it waiting.
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="test-card" data-testid="test-card">
      <p className="small muted">{t("pay.testCardHint")}</p>
      <button type="button" disabled={busy} onClick={() => void tap(false)}>
        {t("pay.testCard")}
      </button>
      <button type="button" disabled={busy} onClick={() => void tap(true)}>
        {t("pay.testCardDeclined")}
      </button>
    </div>
  );
}
