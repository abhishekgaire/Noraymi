"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { t } from "@west4/shared";

/** Picking a start time holds a real room for 10 minutes (M5-07), then the page moves to the booking's link. */
export function HoldButton({
  slug,
  base,
  date,
  time,
  zone,
  offset,
  hours,
  guests,
  label,
}: {
  slug: string;
  base: string;
  date: string;
  time: string;
  zone: string;
  offset: string;
  hours: number;
  guests: number;
  label: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hold = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/v1/public/venues/${encodeURIComponent(slug)}/bookings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ business_date: date, time, offset, hours, party_size: guests }),
      });
      const body = (await r.json()) as { token?: string };
      if (!r.ok || !body.token) {
        setError(t("en", "site.book.holdFailed"));
        return;
      }
      router.push(`${base}/book/${body.token}`);
    } catch {
      setError(t("en", "site.book.holdFailed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        className="slot"
        disabled={busy}
        aria-label={t("en", "site.book.holdAria", { time: label, zone })}
        onClick={() => void hold()}
      >
        {label}
        <span className="small"> {zone}</span>
      </button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
