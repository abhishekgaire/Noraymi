import { useCallback, useEffect, useRef, useState } from "react";
import type { Cents } from "@west4/shared";
import { api } from "../api.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";

/** `GET /v1/venues/{v}/glance` (P-12). */
interface GlanceAnswer {
  readonly business_date: string;
  /** The X report's net sales; null for anyone who can't open the X report. */
  readonly sales_cents: number | null;
  readonly open_checks: number;
  readonly rooms_in_use: number;
  /** Null while Team, time clock & tips is off. */
  readonly on_the_clock: number | null;
}

const REFETCH_MS = 60_000;
/** Events that move a number, gathered so a busy bar doesn't recompute the X report on every line. */
const SETTLE_MS = 3_000;
const MOVES = new Set([
  "room.updated",
  "check.updated",
  "tab.updated",
  "payment.updated",
  "shift.updated",
  "order.accepted",
]);

/**
 * Tonight at a glance (P-12): for owners and managers, the top of Rooms shows
 * sales so far (the running X report's net sales), open checks, rooms in use
 * and who's on the clock. Sales show only to someone who can open the X report;
 * the server leaves it out for anyone else.
 */
export function Glance({ venueId }: { venueId: string }) {
  const { t, money } = useT();
  const { subscribe } = useEvents();
  const [answer, setAnswer] = useState<GlanceAnswer | null>(null);
  const [failed, setFailed] = useState(false);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      setAnswer(await api<GlanceAnswer>("GET", `/v1/venues/${venueId}/glance`));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [venueId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFETCH_MS);
    return () => {
      clearInterval(timer);
      if (pending.current) clearTimeout(pending.current);
    };
  }, [load]);

  useEffect(
    () =>
      subscribe((events) => {
        if (events.length > 0 && !events.some((e) => MOVES.has(e.type))) return;
        if (pending.current) return;
        pending.current = setTimeout(() => {
          pending.current = null;
          void load();
        }, SETTLE_MS);
      }),
    [subscribe, load],
  );

  if (!answer)
    return failed ? (
      <p className="error glance-state" role="alert">
        {t("glance.failed")}
      </p>
    ) : (
      <p className="muted glance-state" role="status">
        {t("glance.loading")}
      </p>
    );

  return (
    <section className="board-boxes glance" aria-label={t("glance.label")}>
      {answer.sales_cents !== null && (
        <div className="lime" data-glance="sales">
          <b>{money(answer.sales_cents as Cents)}</b>
          <span>{t("glance.sales")}</span>
        </div>
      )}
      <div data-glance="open-checks">
        <b>{answer.open_checks}</b>
        <span>{t("glance.openChecks")}</span>
      </div>
      <div data-glance="rooms-in-use">
        <b>{answer.rooms_in_use}</b>
        <span>{t("glance.roomsInUse")}</span>
      </div>
      {answer.on_the_clock !== null && (
        <div data-glance="on-the-clock">
          <b>{answer.on_the_clock}</b>
          <span>{t("glance.onTheClock")}</span>
        </div>
      )}
      {failed && (
        <p className="error glance-stale" role="alert">
          {t("glance.failed")}
        </p>
      )}
    </section>
  );
}
