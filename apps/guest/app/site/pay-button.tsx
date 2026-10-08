"use client";
import { useState } from "react";
import { t } from "@west4/shared";

/**
 * Terms → Payment (M5-09): the booking's one deposit payment gets a pay link,
 * and the guest goes to the payment page on its own origin. The booking's
 * link rides in the fragment, which never reaches a server, so the payment
 * page can bring the guest back to it once paid (M5-10).
 */
export function PayButton({ token, label }: { token: string; label: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/v1/public/bookings/${encodeURIComponent(token)}/pay`, {
        method: "POST",
      });
      const body = (await r.json().catch(() => null)) as {
        pay_url?: string;
        error?: { details?: { reason?: string } };
      } | null;
      if (r.ok && body?.pay_url) {
        window.location.assign(`${body.pay_url}#b=${encodeURIComponent(token)}`);
        return;
      }
      if (body?.error?.details?.reason === "hold_over") window.location.reload();
      else setError(t("en", "site.book.payFailed"));
    } catch {
      setError(t("en", "site.book.payFailed"));
    }
    setBusy(false);
  };
  return (
    <>
      {error && <p role="alert">{error}</p>}
      <button type="button" className="button primary" disabled={busy} onClick={() => void go()}>
        {label}
      </button>
    </>
  );
}
