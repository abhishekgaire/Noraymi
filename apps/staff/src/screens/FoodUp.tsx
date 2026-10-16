import { useCallback, useEffect, useState } from "react";
import { formatTime, Temporal } from "@west4/shared";
import { api } from "../api.js";
import { useT } from "../i18n.js";
import { useModuleOn } from "../useModule.js";
import type { KitchenTicket } from "./KitchenScreen.js";
import "./kitchen.css";

/** How long a bumped ticket stays on the bar's "Food up" strip. */
const SHOWN_MIN = 15;
const POLL_MS = 3_000;
const SEEN = "west4.kitchen.foodUpSeen";

function seenIds(): string[] {
  try {
    return JSON.parse(localStorage.getItem(SEEN) ?? "[]") as string[];
  } catch {
    return [];
  }
}

/**
 * The bar is told (P-17): while the Kitchen screen is on, each ticket the kitchen bumps with Done
 * shows here as "Food up · Room 3 · 11:52" for fifteen minutes, until someone taps Got it. Also
 * opens the kitchen screen in a second window on this bar computer.
 */
export function FoodUp({ venueId, timeZone }: { venueId: string; timeZone: string }) {
  const { t, locale } = useT();
  const on = useModuleOn("kitchen_screen");
  const [done, setDone] = useState<KitchenTicket[]>([]);
  const [now, setNow] = useState<string | null>(null);
  const [seen, setSeen] = useState<string[]>(seenIds);

  const load = useCallback(async () => {
    try {
      const r = await api<{ tickets: KitchenTicket[]; now: string }>(
        "GET",
        `/v1/venues/${venueId}/kitchen/tickets?view=done`,
      );
      setDone(r.tickets);
      setNow(r.now);
    } catch {
      // The strip is a reminder: the bar orders screen shows its own connection error.
    }
  }, [venueId]);
  useEffect(() => {
    if (!on) return;
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [on, load]);
  if (!on) return null;

  const cutoff = now ? Temporal.Instant.from(now).epochMilliseconds - SHOWN_MIN * 60_000 : 0;
  const shown = done.filter(
    (k) =>
      k.done_at !== null &&
      !seen.includes(k.id) &&
      Temporal.Instant.from(k.done_at).epochMilliseconds >= cutoff,
  );
  const gotIt = (id: string) => {
    const next = [...seen, id].slice(-100);
    setSeen(next);
    try {
      localStorage.setItem(SEEN, JSON.stringify(next));
    } catch {
      // Not kept: the strip forgets it after fifteen minutes anyway.
    }
  };

  return (
    <section className="food-up" aria-label={t("kitchenScreen.foodUp.title")}>
      <button type="button" onClick={() => window.open("/kitchen-screen", "west4-kitchen")}>
        {t("kitchenScreen.openWindow")}
      </button>
      {shown.length > 0 && (
        <ul>
          {shown.map((k) => (
            <li key={k.id} role="status">
              <span>
                {t("kitchenScreen.foodUp", {
                  room: k.room ?? "—",
                  time: formatTime(locale, k.done_at!, timeZone),
                })}
              </span>
              <button type="button" onClick={() => gotIt(k.id)}>
                {t("kitchenScreen.gotIt")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
