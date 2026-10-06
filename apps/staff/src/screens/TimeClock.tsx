import { useCallback, useEffect, useState } from "react";
import { shiftMinutes, type Duty, type Punch } from "@west4/rules";
import type { Temporal } from "@west4/shared";
import { api, ApiCallError } from "../api.js";
import { useClock } from "../clock.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";
import { useSession } from "../session.js";

/**
 * The time clock (M7-01; screens Pin note 2, N24): clock in with a duty
 * (Bar, Front desk, Runner or Manager), take a break, clock out. The panel
 * is the signed-in person's own clock, on Pin after a badge or name and PIN
 * and on the staff phone's "Clock in and out" tab. Hours so far come from
 * the shift's punches by elapsed time, never the device's clock.
 */
export interface ShiftView {
  readonly id: string;
  readonly duty: Duty;
  readonly business_date: string;
  readonly started_at: string;
  readonly break_minutes: number;
  readonly break_started_at: string | null;
  readonly punches: readonly Punch[];
}

export interface ClockAnswer {
  readonly server_time: string;
  readonly me: {
    readonly membership_id: string;
    readonly duties: readonly Duty[];
    readonly shift: ShiftView | null;
  };
  readonly team: readonly {
    readonly membership_id: string;
    readonly name: string;
    readonly role: string;
    readonly shift: ShiftView | null;
  }[];
}

/** Worked so far, as hours and minutes: elapsed time from clock-in minus breaks. */
export function soFar(
  shift: { readonly punches: readonly Punch[] },
  now: Temporal.Instant | string,
): { hours: number; minutes: number } {
  const worked = shiftMinutes(shift.punches, now).workedMinutes;
  return { hours: Math.floor(worked / 60), minutes: worked % 60 };
}

/** One person's line: "Maya S. · on since 4:00 PM (6h 41m)", on break, or not on shift. */
export function useShiftLine() {
  const { t, time } = useT();
  return (
    name: string,
    shift: ShiftView | null,
    now: Temporal.Instant | string,
    timeZone: string,
  ): string =>
    !shift
      ? t("clock.personOff", { name })
      : shift.break_started_at
        ? t("clock.personOnBreak", { name, time: time(shift.break_started_at, timeZone) })
        : t("clock.personOnSince", {
            name,
            time: time(shift.started_at, timeZone),
            ...soFar(shift, now),
          });
}

export function ClockPanel({
  onDone,
  doneLabel,
}: {
  /** Pin shows a way on (to the home screen); the phone's tab doesn't need one. */
  readonly onDone?: (onTheClock: boolean) => void;
  readonly doneLabel?: "clock.done" | "clock.notNow";
}) {
  const { t, time } = useT();
  const { state } = useSession();
  const clock = useClock();
  const { subscribe } = useEvents();
  const signedIn = state.status === "signedIn" ? state : null;
  const venueId = signedIn?.membership.venue_id ?? "";
  const timeZone = signedIn?.membership.venue.time_zone ?? "America/New_York";
  const [answer, setAnswer] = useState<ClockAnswer | null>(null);
  const [duty, setDuty] = useState<Duty | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!venueId) return;
    try {
      const a = await api<ClockAnswer>("GET", `/v1/venues/${venueId}/shifts`);
      setAnswer(a);
      clock.sync(a.server_time);
      setError(null);
    } catch {
      setError(t("shell.error.cantReach"));
    }
    // The clock's sync is stable; t changes only with the language.
  }, [venueId, t]);
  useEffect(() => void load(), [load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (events.length === 0 || events.some((e) => e.type === "shift.updated")) void load();
      }),
    [subscribe, load],
  );

  const punch = async (path: string, body?: unknown) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api("POST", `/v1/venues/${venueId}/shifts/${path}`, body);
      if (path === "clock-out") setNotice(t("clock.clockedOut"));
      setDuty(null);
      await load();
    } catch (e) {
      setError(
        e instanceof ApiCallError && e.status === 409
          ? t("clock.refused")
          : t("shell.error.cantReach"),
      );
      await load();
    } finally {
      setBusy(false);
    }
  };

  const now = clock.now ?? answer?.server_time ?? null;
  const shift = answer?.me.shift ?? null;

  return (
    <section className="time-clock" aria-label={t("clock.title")}>
      {answer === null && !error && <p role="status">{t("shell.loading")}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {answer && shift && now && (
        <>
          <p className="clock-status" role="status">
            {shift.break_started_at
              ? t("clock.onBreakSince", { time: time(shift.break_started_at, timeZone) })
              : t("clock.onSince", {
                  time: time(shift.started_at, timeZone),
                  ...soFar(shift, now),
                })}
          </p>
          <p className="muted small">{t("clock.duty", { duty: t(`clock.duty.${shift.duty}`) })}</p>
          <div className="actions">
            {shift.break_started_at ? (
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void punch("break", { action: "end" })}
              >
                {t("clock.endBreak")}
              </button>
            ) : (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void punch("break", { action: "start" })}
              >
                {t("clock.startBreak")}
              </button>
            )}
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void punch("clock-out")}
            >
              {t("clock.clockOut")}
            </button>
          </div>
        </>
      )}
      {answer && !shift && (
        <>
          <p className="clock-status" role="status">
            {t("clock.notOnShift")}
          </p>
          <fieldset className="duties">
            <legend>{t("clock.pickDuty")}</legend>
            <div className="chips">
              {answer.me.duties.map((d) => (
                <button key={d} type="button" aria-pressed={duty === d} onClick={() => setDuty(d)}>
                  {t(`clock.duty.${d}`)}
                </button>
              ))}
            </div>
          </fieldset>
          <button
            type="button"
            className="primary"
            disabled={busy || duty === null}
            onClick={() => void punch("clock-in", { duty })}
          >
            {t("clock.clockIn")}
          </button>
        </>
      )}
      {onDone && answer && (
        <button type="button" className="secondary" onClick={() => onDone(shift !== null)}>
          {t(doneLabel ?? "clock.done")}
        </button>
      )}
      <p className="muted small">{t("clock.rule")}</p>
    </section>
  );
}

/** The staff phone's "Clock in and out" tab: your own clock, then who's on the clock. */
export function TimeClock() {
  const { t } = useT();
  const { state } = useSession();
  const clock = useClock();
  const { subscribe } = useEvents();
  const line = useShiftLine();
  const signedIn = state.status === "signedIn" ? state : null;
  const venueId = signedIn?.membership.venue_id ?? "";
  const timeZone = signedIn?.membership.venue.time_zone ?? "America/New_York";
  const [team, setTeam] = useState<ClockAnswer["team"] | null>(null);

  const load = useCallback(async () => {
    if (!venueId) return;
    try {
      setTeam((await api<ClockAnswer>("GET", `/v1/venues/${venueId}/shifts`)).team);
    } catch {
      // The panel above shows the error.
    }
  }, [venueId]);
  useEffect(() => void load(), [load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (events.length === 0 || events.some((e) => e.type === "shift.updated")) void load();
      }),
    [subscribe, load],
  );

  return (
    <section className="screen">
      <h1>{t("clock.title")}</h1>
      <ClockPanel />
      <h2>{t("clock.onTheClock")}</h2>
      {team && clock.now && (
        <ul className="bookings-list" aria-label={t("clock.onTheClock")}>
          {team.map((p) => (
            <li key={p.membership_id} className={p.shift ? "on-clock" : "off-clock"}>
              {line(p.name, p.shift, clock.now!, timeZone)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
