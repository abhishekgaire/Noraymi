"use client";

import { useCallback, useEffect, useState } from "react";
import { t } from "@west4/shared";

interface SpotView {
  readonly venue_name: string;
  readonly name: string;
  readonly party_size: number;
  readonly bills_as: number;
  readonly day_of_week: number;
  readonly status: "waiting" | "offered" | "seated" | "declined" | "expired" | "left";
  readonly ahead: number | null;
  readonly quoted_min: number | null;
  readonly offer: {
    readonly room_name: string;
    readonly expires_at: string | null;
    readonly seconds_left: number | null;
  } | null;
}

const REFRESH_MS = 15_000;

/** The place in line from the live list, refreshed every 15 seconds; leaving and giving an offer away. */
export function Spot({ token }: { token: string }) {
  const [spot, setSpot] = useState<SpotView | null>(null);
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState(false);
  // The countdown runs from the server's seconds left on the page's steady timer, never the phone's clock.
  const [fetchedAt, setFetchedAt] = useState(() => performance.now());
  const [now, setNow] = useState(() => performance.now());

  const load = useCallback(async () => {
    const r = await fetch(`/v1/public/waitlist/${token}`, { cache: "no-store" }).catch(() => null);
    if (!r) return;
    if (r.status === 404) {
      setGone(true);
      return;
    }
    if (r.ok) {
      setSpot(((await r.json()) as { spot: SpotView }).spot);
      setFetchedAt(performance.now());
    }
  }, [token]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    const tick = setInterval(() => setNow(performance.now()), 1000);
    return () => {
      clearInterval(timer);
      clearInterval(tick);
    };
  }, [load]);

  const act = async (action: "leave" | "decline") => {
    setBusy(true);
    const r = await fetch(`/v1/public/waitlist/${token}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    }).catch(() => null);
    if (r?.ok) {
      setSpot(((await r.json()) as { spot: SpotView }).spot);
      setFetchedAt(performance.now());
    }
    setBusy(false);
  };

  if (gone)
    return (
      <main className="guest">
        <p>{t("en", "guestWait.gone")}</p>
      </main>
    );
  if (!spot)
    return (
      <main className="guest">
        <p role="status">…</p>
      </main>
    );

  const ahead =
    spot.ahead === null
      ? null
      : spot.ahead === 0
        ? t("en", "guestWait.ahead.none")
        : spot.ahead === 1
          ? t("en", "guestWait.ahead.one")
          : t("en", "guestWait.ahead.many", { count: spot.ahead });
  const day =
    spot.day_of_week === 5 || spot.day_of_week === 6
      ? t("en", `dayName.${spot.day_of_week}` as "dayName.5")
      : t("en", "dayName.other");
  const left =
    spot.offer?.seconds_left === null || spot.offer?.seconds_left === undefined
      ? null
      : Math.max(0, spot.offer.seconds_left - Math.floor((now - fetchedAt) / 1000));
  const clock =
    left === null ? "" : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;

  return (
    <main className="guest">
      <h1>{spot.venue_name}</h1>
      <p>{t("en", "guestWait.party.line", { name: spot.name, party: spot.party_size })}</p>
      {spot.bills_as > spot.party_size && (
        <p>{t("en", "guestWait.billsAs", { party: spot.party_size, bills: spot.bills_as, day })}</p>
      )}
      {spot.status === "waiting" && (
        <>
          <p className="big" role="status">
            {ahead}
          </p>
          <p>
            {spot.quoted_min === null
              ? t("en", "guestWait.noQuote")
              : t("en", "guestWait.quote", { min: spot.quoted_min })}
          </p>
          <button type="button" disabled={busy} onClick={() => void act("leave")}>
            {t("en", "guestWait.leave")}
          </button>
        </>
      )}
      {spot.status === "offered" && spot.offer && (
        <>
          <p className="big" role="status">
            {t("en", "guestWait.offer", { room: spot.offer.room_name, time: clock })}
          </p>
          <button type="button" disabled={busy} onClick={() => void act("decline")}>
            {t("en", "guestWait.decline")}
          </button>
        </>
      )}
      {spot.status === "left" && <p role="status">{t("en", "guestWait.left")}</p>}
      {spot.status === "declined" && <p role="status">{t("en", "guestWait.declined")}</p>}
      {spot.status === "seated" && <p role="status">{t("en", "guestWait.seated")}</p>}
      {spot.status === "expired" && <p role="status">{t("en", "guestWait.expired")}</p>}
    </main>
  );
}
