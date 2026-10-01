import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "../api.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";

/**
 * The headcount on the board (M2-28; screens N31): everyone inside, from the
 * rooms, the waitlist and the door counter, against the occupancy limit. With
 * no limit set it says so and shows no number; with one, it warns at the
 * share Admin → Safety sets.
 */
interface Count {
  readonly inside: number;
  readonly in_rooms: number;
  readonly waiting: number;
  readonly door: number;
  readonly limit: number | null;
  readonly warn: boolean;
}

export function Headcount({ venueId, canCount }: { venueId: string; canCount: boolean }) {
  const { t } = useT();
  const { subscribe } = useEvents();
  const [count, setCount] = useState<Count | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setCount(await api<Count>("GET", `/v1/venues/${venueId}/headcount`));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [venueId]);
  useEffect(() => void load(), [load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (
          events.length === 0 ||
          events.some(
            (e) =>
              e.type === "headcount.updated" ||
              e.type === "room.updated" ||
              e.type === "waitlist.updated",
          )
        )
          void load();
      }),
    [subscribe, load],
  );

  const door = async (delta: 1 | -1) => {
    try {
      setCount(await api<Count>("POST", `/v1/venues/${venueId}/door-counts`, { delta }));
    } catch {
      setFailed(true);
    }
  };

  if (!count) return failed ? <p className="error">{t("headcount.failed")}</p> : null;
  return (
    <div
      className={count.warn ? "headcount warn" : "headcount"}
      role="group"
      aria-live="polite"
      aria-label={t("headcount.title")}
    >
      <strong>{t("headcount.inside", { count: count.inside })}</strong>
      <span className="small">
        {t("headcount.parts", { rooms: count.in_rooms, waiting: count.waiting })}
      </span>
      {count.limit === null ? (
        <Link className="small" to="/admin/safety">
          {t("headcount.noLimit")}
        </Link>
      ) : (
        <span className={count.warn ? "small error" : "small"}>
          {count.warn
            ? t("headcount.near", { inside: count.inside, limit: count.limit })
            : t("headcount.limit", { limit: count.limit })}
        </span>
      )}
      {canCount && (
        <span className="party-size">
          <button
            type="button"
            className="icon-button"
            aria-label={t("headcount.out")}
            onClick={() => void door(-1)}
          >
            −
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t("headcount.in")}
            onClick={() => void door(1)}
          >
            +
          </button>
        </span>
      )}
    </div>
  );
}
