"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { t } from "@west4/shared";
import { captchaRefusal } from "../captcha";
import { useHoldCaptcha } from "./hold-captcha";

/**
 * Picking a start time holds a real room for 10 minutes (M5-07), then the page moves to the booking's link.
 * The hold carries Book's security check (M5-05); past a daily limit the guest is told to call.
 */
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
  const captcha = useHoldCaptcha();
  const hold = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/v1/public/venues/${encodeURIComponent(slug)}/bookings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          business_date: date,
          time,
          offset,
          hours,
          party_size: guests,
          captcha_token: captcha?.token ?? "",
        }),
      });
      const body = (await r.json()) as { token?: string; error?: { code?: string } };
      if (!r.ok || !body.token) {
        captcha?.reset();
        setError(captchaRefusal(body, "guestLimit.booking") ?? t("en", "site.book.holdFailed"));
        return;
      }
      router.push(`${base}/book/${body.token}`);
    } catch {
      captcha?.reset();
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
        disabled={busy || !captcha?.token}
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
