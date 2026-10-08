"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { t } from "@west4/shared";

/**
 * The Details step (M5-08; Payment flows · the Details step; screens N1):
 * name, mobile (+1 only) and email; a line saying the confirmation and
 * reminders come by text to that number; and, while Marketing texts is on,
 * an unticked box for marketing texts, separate from the booking, in the
 * exact words its consent records.
 */
export function DetailsForm({
  token,
  initial,
  marketingBox,
}: {
  token: string;
  initial: { name: string; phone: string | null; email: string | null } | null;
  marketingBox: { id: string; text: string } | null;
}) {
  const router = useRouter();
  const [name, setName] = useState(initial?.name ?? "");
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [marketing, setMarketing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const digits = phone.replace(/\D/g, "");
    const e164 =
      digits.length === 10 ? `+1${digits}` : digits.length === 11 ? `+${digits}` : phone.trim();
    try {
      const r = await fetch(`/v1/public/bookings/${encodeURIComponent(token)}/details`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, phone: e164, email, marketing }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as {
          error?: { details?: { reason?: string } };
        } | null;
        if (body?.error?.details?.reason === "hold_over") window.location.reload();
        else setError(t("en", "site.book.detailsFailed"));
        return;
      }
      router.refresh();
    } catch {
      setError(t("en", "site.book.detailsFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="details-h" className="details">
      <h2 id="details-h">{t("en", "site.book.details")}</h2>
      <form className="pick" onSubmit={(e) => void submit(e)}>
        <label>
          {t("en", "site.book.name")}
          <input
            required
            maxLength={80}
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          {t("en", "site.book.mobile")}
          <input
            required
            type="tel"
            autoComplete="tel"
            aria-describedby="texts-line"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </label>
        <p id="texts-line" className="small">
          {t("en", "site.book.textsLine")}
        </p>
        <label>
          {t("en", "site.book.email")}
          <input
            required
            type="email"
            autoComplete="email"
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        {marketingBox && (
          <label className="check">
            <input
              type="checkbox"
              checked={marketing}
              onChange={(e) => setMarketing(e.target.checked)}
            />
            <span>{marketingBox.text}</span>
          </label>
        )}
        {error && <p role="alert">{error}</p>}
        <button type="submit" className="button" disabled={busy}>
          {t("en", initial ? "site.book.changeDetails" : "site.book.saveDetails")}
        </button>
      </form>
    </section>
  );
}
