"use client";
import { useEffect, useState } from "react";
import { t } from "@west4/shared";

/**
 * The hold's countdown on every step after Pick (M5-07; Security and data
 * retention 14; WCAG 2.2 · Timing adjustable): it counts on the server's
 * seconds-left, announces each whole minute to screen readers, and at one
 * minute left offers "More time" (10 more minutes, at least ten times).
 */
export function Countdown({
  token,
  secondsLeft,
  moreTimeLeft,
  moreTimeUrl,
}: {
  token: string;
  secondsLeft: number;
  moreTimeLeft: number;
  /** The payment page extends the hold through its own pay link (M5-09). */
  moreTimeUrl?: string;
}) {
  const [left, setLeft] = useState(secondsLeft);
  const [more, setMore] = useState(moreTimeLeft);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const started = Date.now();
    const from = left;
    const id = setInterval(() => {
      setLeft(Math.max(0, from - Math.floor((Date.now() - started) / 1000)));
    }, 1000);
    return () => clearInterval(id);
    // Restarts when the server gives a new figure (after More time).
  }, [secondsLeft, busy]);
  useEffect(() => {
    if (left === 0) window.location.reload();
  }, [left]);

  const extend = async () => {
    setBusy(true);
    try {
      const url = moreTimeUrl ?? `/v1/public/bookings/${encodeURIComponent(token)}/more-time`;
      const r = await fetch(url, {
        method: "POST",
      });
      if (r.ok) {
        const body = (await r.json()) as {
          seconds_left?: number | null;
          more_time_left?: number;
          deposit?: { seconds_left: number | null; more_time_left: number } | null;
        };
        const b = body.deposit ?? body;
        setLeft(b.seconds_left ?? 0);
        setMore(b.more_time_left ?? 0);
      }
    } finally {
      setBusy(false);
    }
  };

  const mm = Math.floor(left / 60);
  const ss = String(left % 60).padStart(2, "0");
  // Announced once a minute, and at the one-minute mark.
  const spoken =
    left > 60
      ? t("en", "site.book.leftAnnounce", { n: Math.ceil(left / 60) })
      : t("en", "site.book.oneMinute");
  return (
    <div className="countdown">
      <p>
        <span aria-hidden="true">{t("en", "site.book.left", { time: `${mm}:${ss}` })}</span>
      </p>
      <p className="visually-hidden" role="status" aria-live="polite">
        {spoken}
      </p>
      {left <= 60 && more > 0 && (
        <button type="button" className="button" disabled={busy} onClick={() => void extend()}>
          {t("en", "site.book.moreTime")}
        </button>
      )}
    </div>
  );
}
