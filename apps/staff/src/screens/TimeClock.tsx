import { Fragment, useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { shiftMinutes, type Duty, type Punch } from "@west4/rules";
import { parseDollars, type Cents, type Temporal } from "@west4/shared";
import { api, ApiCallError } from "../api.js";
import { useClock } from "../clock.js";
import { useConnection } from "../connection.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";
import { useSession } from "../session.js";
import { DrawerPanel } from "./DrawerPanel.js";

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
    /** The duty of their last shift, picked for them at Clock in (U-14). */
    readonly last_duty?: Duty | null;
  };
  readonly team: readonly {
    readonly membership_id: string;
    readonly user_id: string;
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
  // Clocking in and out is the server's: offline, the buttons wait and the panel says why.
  const offline = useConnection().kind === "offline";
  const signedIn = state.status === "signedIn" ? state : null;
  const venueId = signedIn?.membership.venue_id ?? "";
  const timeZone = signedIn?.membership.venue.time_zone ?? "America/New_York";
  const [answer, setAnswer] = useState<ClockAnswer | null>(null);
  const [duty, setDuty] = useState<Duty | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The clock-out checklist (M7-11), shown before the first tap (U-14).
  const [checklist, setChecklist] = useState<readonly ChecklistItem[] | null>(null);
  // The cash tips typed on it: Clock out declares them in the same call (U-14).
  const [tips, setTips] = useState("");
  // Just clocked out here: the panel says so and doesn't ask for a duty again (U-14).
  const [clockedOut, setClockedOut] = useState(false);

  const loadChecklist = useCallback(async () => {
    if (!venueId) return;
    try {
      setChecklist(
        (await api<{ items: ChecklistItem[] }>("GET", `/v1/venues/${venueId}/shifts/checklist`))
          .items,
      );
    } catch {
      // Clock out still asks the server, which answers with the list.
    }
  }, [venueId]);

  const load = useCallback(async () => {
    if (!venueId) return;
    try {
      const a = await api<ClockAnswer>("GET", `/v1/venues/${venueId}/shifts`);
      setAnswer(a);
      clock.sync(a.server_time);
      setError(null);
      // One duty is picked for them; otherwise the one they used last (U-14).
      setDuty((d) => d ?? (a.me.duties.length === 1 ? a.me.duties[0]! : (a.me.last_duty ?? null)));
      if (a.me.shift) await loadChecklist();
      else setChecklist(null);
    } catch {
      setError(t("shell.error.cantReach"));
    }
    // The clock's sync is stable; t changes only with the language.
  }, [venueId, t, loadChecklist]);
  useEffect(() => void load(), [load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (events.length === 0 || events.some((e) => e.type === "shift.updated")) void load();
        else if (events.some((e) => e.type === "drawer.updated" || e.type.startsWith("tab.")))
          void loadChecklist();
      }),
    [subscribe, load, loadChecklist],
  );

  const punch = async (path: "clock-in" | "clock-out" | "break", body?: unknown) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api("POST", `/v1/venues/${venueId}/shifts/${path}`, body);
      if (path === "clock-in" && onDone) {
        // Clock in goes straight to their home screen (U-14).
        onDone(true);
        return;
      }
      if (path === "clock-out") {
        setNotice(t("clock.clockedOut"));
        setClockedOut(true);
        setChecklist(null);
        setTips("");
      }
      await load();
    } catch (e) {
      if (e instanceof ApiCallError && e.code === "checklist_open") {
        // The declaration rolled back with the refusal: the tips box stays, with what was typed.
        const items = e.details["items"] as ChecklistItem[];
        const sentTips = path === "clock-out" && body !== undefined;
        setChecklist(
          sentTips && !items.some((i) => i.kind === "declare_tips")
            ? [...items, { kind: "declare_tips" }]
            : items,
        );
      } else
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
  const owesTips = checklist?.some((i) => i.kind === "declare_tips") ?? false;
  const tipCents = parseDollars(tips, 6);
  const clockOut = () =>
    void punch(
      "clock-out",
      owesTips && tipCents !== null ? { cash_tips_cents: tipCents } : undefined,
    );

  return (
    <section className="time-clock" aria-label={t("clock.title")}>
      {answer === null && !error && <p role="status">{t("shell.loading")}</p>}
      {offline && (
        <p className="notice" role="status">
          {t("clock.offline")}
        </p>
      )}
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
          {checklist && checklist.length > 0 && (
            <Checklist
              venueId={venueId}
              items={checklist}
              onTheClock={answer.team.filter(
                (p) => p.shift !== null && p.membership_id !== answer.me.membership_id,
              )}
              manager={answer.me.duties.includes("manager")}
              tips={tips}
              onTips={setTips}
              disabled={busy || offline}
              onChanged={() => void loadChecklist()}
            />
          )}
          <div className="actions">
            {shift.break_started_at ? (
              <button
                type="button"
                className="primary"
                disabled={busy || offline}
                onClick={() => void punch("break", { action: "end" })}
              >
                {t("clock.endBreak")}
              </button>
            ) : (
              <button
                type="button"
                className="secondary"
                disabled={busy || offline}
                onClick={() => void punch("break", { action: "start" })}
              >
                {t("clock.startBreak")}
              </button>
            )}
            <button
              type="button"
              className={owesTips ? "primary" : "secondary"}
              disabled={busy || offline || (owesTips && tipCents === null)}
              onClick={clockOut}
            >
              {t("clock.clockOut")}
            </button>
          </div>
        </>
      )}
      {answer && !shift && !clockedOut && (
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
            disabled={busy || offline || duty === null}
            onClick={() => void punch("clock-in", { duty })}
          >
            {t("clock.clockIn")}
          </button>
        </>
      )}
      {onDone && answer && (
        <button type="button" className="secondary" onClick={() => onDone(shift !== null)}>
          {t(clockedOut ? "clock.done" : (doneLabel ?? "clock.done"))}
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

/** One line of the clock-out checklist (M7-11), as the API answers it. */
type ChecklistItem =
  | { readonly kind: "open_tab"; readonly tab_id: string; readonly name: string }
  | { readonly kind: "unsent"; readonly tab_name: string | null; readonly drinks: number }
  | { readonly kind: "staff_bank"; readonly cash_cents: number }
  | { readonly kind: "own_drawer"; readonly drawer: string }
  | { readonly kind: "declare_tips" }
  | { readonly kind: "drawer_handover" };

/**
 * The clock-out checklist (M7-11; screens N24), shown before the first tap
 * (U-14), each line with its action: open tabs all go to one person still
 * on the clock in one tap ("Close these tabs" at the bar POS when nobody
 * else is on); unsent drinks go with their tab; Drop my cash drops the staff
 * bank into this screen's drawer; Count and the drawer handover open the
 * drawers here. Cash tips are typed here, or $0 tapped, and Clock out
 * declares them in the same call.
 */
function Checklist({
  venueId,
  items,
  onTheClock,
  manager,
  tips,
  onTips,
  disabled,
  onChanged,
}: {
  venueId: string;
  items: readonly ChecklistItem[];
  onTheClock: readonly { readonly user_id: string; readonly name: string }[];
  manager: boolean;
  tips: string;
  onTips: (text: string) => void;
  disabled: boolean;
  onChanged: () => void;
}) {
  const { t, money } = useT();
  const [to, setTo] = useState<string>("");
  const [failed, setFailed] = useState(false);
  const [drawers, setDrawers] = useState(false);
  const [working, setWorking] = useState(false);
  const run = async (call: () => Promise<unknown>) => {
    setFailed(false);
    setWorking(true);
    try {
      await call();
    } catch {
      setFailed(true);
    } finally {
      setWorking(false);
      onChanged();
    }
  };
  const tabs = items.filter(
    (i): i is Extract<ChecklistItem, { kind: "open_tab" }> => i.kind === "open_tab",
  );
  // The person the tabs go to: the one picked, else the first still on the clock.
  const taker = onTheClock.find((p) => p.user_id === to) ?? onTheClock[0] ?? null;
  const handAll = () =>
    run(async () => {
      for (const tab of tabs)
        await api("POST", `/v1/venues/${venueId}/tabs/${tab.tab_id}/hand-over`, {
          to: taker!.user_id,
        });
    });
  // Drop my cash: into this screen's open drawer; with none here, the drawers open below.
  const dropHere = () =>
    run(async () => {
      const r = await api<{
        drawers: readonly {
          here: boolean;
          sessions: readonly { id: string; state: string }[];
        }[];
      }>("GET", `/v1/venues/${venueId}/drawers`);
      const session = r.drawers
        .find((d) => d.here && d.sessions.some((s) => s.state === "open"))
        ?.sessions.find((s) => s.state === "open");
      if (!session) {
        setDrawers(true);
        return;
      }
      await api("POST", `/v1/venues/${venueId}/drawer-sessions/${session.id}/drop`, undefined, {
        idempotencyKey: `drop-${session.id}-${Date.now()}`,
      });
    });
  const off = disabled || working;
  return (
    <section className="checklist" aria-label={t("checklist.title")}>
      <h3>{t("checklist.title")}</h3>
      <ul>
        {tabs.length > 0 && (
          <li className="checklist-tabs">
            <ul>
              {tabs.map((tab) => (
                <li key={tab.tab_id}>{t("checklist.openTab", { name: tab.name })}</li>
              ))}
            </ul>
            {taker ? (
              <div className="actions">
                {onTheClock.length > 1 && (
                  <select
                    aria-label={t("checklist.handAllTo")}
                    value={taker.user_id}
                    onChange={(e) => setTo(e.target.value)}
                  >
                    {onTheClock.map((p) => (
                      <option key={p.user_id} value={p.user_id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                )}
                <button type="button" disabled={off} onClick={() => void handAll()}>
                  {t("checklist.handAll", { name: taker.name })}
                </button>
              </div>
            ) : (
              <Link className="button" to="/bar">
                {t("checklist.closeTabs")}
              </Link>
            )}
          </li>
        )}
        {items.map((item, i) => (
          <Fragment key={i}>
            {item.kind === "unsent" && (
              <li>
                {item.tab_name ? (
                  <span>
                    {t("checklist.unsentTab", { count: item.drinks, name: item.tab_name })}
                  </span>
                ) : (
                  <>
                    <span>{t("checklist.unsent", { count: item.drinks })}</span>
                    <Link className="button" to="/bar">
                      {t("checklist.toBar")}
                    </Link>
                  </>
                )}
              </li>
            )}
            {item.kind === "staff_bank" && (
              <li>
                <span>{t("checklist.bank", { amount: money(item.cash_cents as Cents) })}</span>
                <button type="button" disabled={off} onClick={() => void dropHere()}>
                  {t("checklist.dropMine")}
                </button>
              </li>
            )}
            {item.kind === "own_drawer" && (
              <li>
                <span>{t("checklist.ownDrawer", { drawer: item.drawer })}</span>
                <button type="button" disabled={off} onClick={() => setDrawers(true)}>
                  {t("checklist.count")}
                </button>
              </li>
            )}
            {item.kind === "drawer_handover" && (
              <li>
                <span>{t("checklist.handover")}</span>
                <button type="button" disabled={off} onClick={() => setDrawers(true)}>
                  {t("checklist.handoverIt")}
                </button>
              </li>
            )}
            {item.kind === "declare_tips" && (
              <li className="tips-box">
                <label>
                  <span>{t("checklist.declare")}</span>
                  <input
                    inputMode="decimal"
                    aria-label={t("checklist.declare")}
                    value={tips}
                    onChange={(e) => onTips(e.target.value)}
                  />
                </label>
                <div className="chips">
                  <button
                    type="button"
                    aria-pressed={tips === "0"}
                    disabled={disabled}
                    onClick={() => onTips("0")}
                  >
                    {t("checklist.zero")}
                  </button>
                </div>
                <p className="muted small">{t("checklist.tipsHint")}</p>
              </li>
            )}
          </Fragment>
        ))}
      </ul>
      {drawers && (
        <>
          <DrawerPanel venueId={venueId} canHandOver={manager} />
          <button type="button" className="link" onClick={() => setDrawers(false)}>
            {t("checklist.hideDrawers")}
          </button>
        </>
      )}
      {failed && (
        <p role="alert" className="error">
          {t("drawer.moveFailed")}
        </p>
      )}
    </section>
  );
}
