import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Temporal } from "@west4/shared";
import { api, ApiCallError } from "../api.js";
import { useClock } from "../clock.js";
import { useConnection } from "../connection.js";
import { useT } from "../i18n.js";

/**
 * Close the night's checks and the close (M7-12; screens Night notes 1 and 6;
 * N17): each check before closing with its fix, the clear-out prompt ("Walk
 * every room and the bar · no drinks left out"), and Close the night after one
 * confirmation. Slips not entered and tabs whose capture failed are shown but
 * don't hold the close up.
 *
 * U-15 (D133): the page reads as numbered steps (1 the bar tabs, 2 the drawers,
 * 3 the clear-out, 4 the close), and nothing sends the manager away: a check
 * fixed on this page scrolls to its step, someone still on the clock is clocked
 * out right here (Clock out {name} at [time], with a reason and the manager's
 * PIN in a PIN session, audited as a punch edit), the waitlist clears and the
 * cleaning rooms are marked clean in one tap, and Close the night takes the PIN
 * in a PIN or badge session. Everything here needs the connection.
 */
export interface Check {
  readonly id:
    | "open_rooms"
    | "open_tabs"
    | "on_the_clock"
    | "waitlist"
    | "orders"
    | "approvals"
    | "cleaning"
    | "unsent"
    | "clear_out"
    | "drawers"
    | "slips"
    | "capture_failed"
    | "held_cards";
  readonly count: number;
  readonly blocking: boolean;
  readonly names: readonly string[];
  readonly link: string;
  readonly due_at?: string;
  readonly done?: { readonly by: string; readonly at: string } | null;
  /** Who's still on the clock (membership, last punch) and the rooms still cleaning (U-15). */
  readonly items?: readonly {
    readonly id: string;
    readonly name: string;
    readonly since?: string;
  }[];
}

/** The steps' anchors on Close the night: a check fixed on this page scrolls to its step. */
export const NIGHT_STEPS = {
  tabs: "night-step-tabs",
  drawers: "night-step-drawers",
  clearOut: "night-step-clear-out",
  close: "night-step-close",
  failed: "night-failed",
} as const;
const IN_PAGE: Partial<Record<Check["id"], string>> = {
  open_tabs: NIGHT_STEPS.tabs,
  drawers: NIGHT_STEPS.drawers,
  clear_out: NIGHT_STEPS.clearOut,
  capture_failed: NIGHT_STEPS.failed,
};

const jump = (id: string) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  el.focus({ preventScroll: true });
};

interface ZAtClose {
  readonly printed_at: "bar" | "front_desk" | null;
  readonly emailed_to: readonly string[];
}

/** One numbered step of the close: its number, what to do, and the step's own panel. */
function Step({
  id,
  n,
  title,
  children,
}: {
  id: string;
  n: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="night-step" id={id} tabIndex={-1}>
      <h3 className="night-step-title">
        <span className="night-step-no" aria-hidden="true">
          {n}
        </span>
        {title}
      </h3>
      {children}
    </div>
  );
}

export function NightChecks({
  venueId,
  date: night,
  timeZone,
  checks,
  closed,
  postsTo,
  needsPin,
  tabsStep,
  drawersStep,
  onChanged,
}: {
  venueId: string;
  date: string;
  timeZone: string;
  checks: readonly Check[];
  closed: { readonly closed_at: string; readonly z_number: number } | null;
  postsTo: string | null;
  /** A PIN or badge session: clocking someone out and the close ask for the PIN again. */
  needsPin: boolean;
  tabsStep?: ReactNode;
  drawersStep?: ReactNode;
  onChanged: () => void;
}) {
  const { t, time, date } = useT();
  const offline = useConnection().kind === "offline";
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [sent, setSent] = useState<ZAtClose | null>(null);
  const [clockingOut, setClockingOut] = useState<string | null>(null);
  const blocking = checks.filter((c) => c.blocking);
  const label = (c: Check): string => {
    switch (c.id) {
      case "clear_out":
        return c.done
          ? t("nightCheck.clearOutDone", { name: c.done.by, time: time(c.done.at, timeZone) })
          : t("nightCheck.clearOut", { time: c.due_at ? time(c.due_at, timeZone) : "" });
      case "drawers":
        return c.count === 0
          ? t("nightCheck.drawersCounted")
          : t("nightCheck.drawers", { count: c.count });
      case "slips":
        return t("nightCheck.slips", { count: c.count, date: postsTo ? date(postsTo) : "" });
      default:
        return t(`nightCheck.${c.id}`, { count: c.count });
    }
  };
  const run = async (call: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await call();
      onChanged();
    } catch (e) {
      setError(
        e instanceof ApiCallError && e.code === "night_open"
          ? t("nightCheck.stillOpen", {
              names: (e.details["checks"] as { id: Check["id"]; count: number }[])
                .map((c) =>
                  label({ ...(checks.find((x) => x.id === c.id) ?? c), count: c.count } as Check),
                )
                .join("; "),
            })
          : e instanceof ApiCallError && e.status === 401
            ? t("nightCheck.wrongPin")
            : t("nightCheck.failed"),
      );
    } finally {
      setBusy(false);
      setConfirming(false);
      setClearing(false);
      setPin("");
    }
  };
  const clearOut = checks.find((c) => c.id === "clear_out");
  const waitlist = checks.find((c) => c.id === "waitlist");
  const pinOk = !needsPin || /^\d{4,6}$/.test(pin);

  /** The fix beside a check: in place where this page fixes it, else a link to the screen that does. */
  const fix = (c: Check): ReactNode => {
    if (c.id === "on_the_clock") return null;
    if (c.id === "waitlist" && c.blocking)
      return (
        <button
          type="button"
          className="link"
          disabled={busy || offline}
          onClick={() => setClearing(true)}
        >
          {t("nightCheck.clearWaitlist")}
        </button>
      );
    if (c.id === "cleaning" && c.blocking && c.items && c.items.length > 0) {
      const rooms = c.items;
      return (
        <button
          type="button"
          className="link"
          disabled={busy || offline}
          onClick={() =>
            void run(async () => {
              for (const room of rooms)
                await api("POST", `/v1/venues/${venueId}/rooms/${room.id}/clean`, {});
            })
          }
        >
          {t("nightCheck.markAllClean")}
        </button>
      );
    }
    if (!(c.blocking || c.id === "slips" || c.id === "capture_failed")) return null;
    const anchor = IN_PAGE[c.id];
    if (anchor)
      return (
        <button type="button" className="link" onClick={() => jump(anchor)}>
          {t("nightCheck.fix")}
        </button>
      );
    return (
      <Link to={c.link} className="link">
        {t("nightCheck.fix")}
      </Link>
    );
  };

  const onTheClock = checks.find((c) => c.id === "on_the_clock");
  return (
    <section className="card night-checks" aria-labelledby="checks-title">
      <h2 id="checks-title">{t("nightCheck.title")}</h2>
      {closed && (
        <p role="status" className="notice">
          {t("nightCheck.closed", { time: time(closed.closed_at, timeZone) })}
        </p>
      )}
      {sent && (
        <p role="status" className="notice">
          {[
            sent.printed_at
              ? t(sent.printed_at === "bar" ? "nightCheck.zPrintedBar" : "nightCheck.zPrintedFront")
              : t("nightCheck.zNoPrinter"),
            sent.emailed_to.length > 0
              ? t("nightCheck.zEmailed", { to: sent.emailed_to.join(", ") })
              : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
      {offline && !closed && (
        <p role="status" className="small muted">
          {t("nightCheck.offline")}
        </p>
      )}
      <ul className="tips-shares">
        {checks
          .filter((c) => (c.id !== "capture_failed" && c.id !== "held_cards") || c.count > 0)
          .map((c) => (
            <li key={c.id} className={`row ${c.blocking ? "warn" : ""}`}>
              <span>
                <span aria-hidden="true">
                  {c.blocking ? "• " : c.count === 0 || c.id === "clear_out" ? "✓ " : "· "}
                </span>
                {label(c)}
                {c.names.length > 0 && c.id !== "slips" && (
                  <span className="small muted" data-guest-text>
                    {" "}
                    · {c.names.join(", ")}
                  </span>
                )}
              </span>
              {fix(c)}
            </li>
          ))}
      </ul>
      {waitlist && clearing && (
        <div className="actions" role="group" aria-label={t("nightCheck.clearWaitlist")}>
          <span>{t("nightCheck.clearWaitlistConfirm", { count: waitlist.count })}</span>
          <button
            type="button"
            className="primary"
            disabled={busy || offline}
            onClick={() => void run(() => api("POST", `/v1/venues/${venueId}/waitlist/clear`, {}))}
          >
            {t("nightCheck.clearWaitlist")}
          </button>
          <button type="button" className="link" onClick={() => setClearing(false)}>
            {t("night.back")}
          </button>
        </div>
      )}
      {onTheClock?.items && onTheClock.items.length > 0 && !closed && (
        <ul
          className="night-on-clock"
          aria-label={t("nightCheck.on_the_clock", { count: onTheClock.count })}
        >
          {onTheClock.items.map((p) =>
            clockingOut === p.id ? (
              <li key={p.id}>
                <ClockOutForm
                  venueId={venueId}
                  timeZone={timeZone}
                  person={p}
                  needsPin={needsPin}
                  offline={offline}
                  onDone={() => {
                    setClockingOut(null);
                    onChanged();
                  }}
                  onCancel={() => setClockingOut(null)}
                />
              </li>
            ) : (
              <li key={p.id}>
                <button
                  type="button"
                  disabled={busy || offline}
                  onClick={() => setClockingOut(p.id)}
                >
                  {t("nightCheck.clockOutWho", { name: p.name })}
                </button>
              </li>
            ),
          )}
        </ul>
      )}

      {tabsStep && (
        <Step id={NIGHT_STEPS.tabs} n={1} title={t("nightStep.tabs")}>
          {tabsStep}
        </Step>
      )}
      {drawersStep && (
        <Step id={NIGHT_STEPS.drawers} n={2} title={t("nightStep.drawers")}>
          {drawersStep}
        </Step>
      )}
      <Step id={NIGHT_STEPS.clearOut} n={3} title={t("nightStep.clearOut")}>
        {clearOut && !clearOut.done && !closed ? (
          <div className="actions">
            <span className="small">{t("nightCheck.clearOutPrompt")}</span>
            <button
              type="button"
              disabled={busy || offline}
              onClick={() =>
                void run(() => api("POST", `/v1/venues/${venueId}/nights/${night}/clear-out`, {}))
              }
            >
              {t("nightCheck.clearOutDo")}
            </button>
          </div>
        ) : (
          clearOut && <p className="small">{label(clearOut)}</p>
        )}
      </Step>
      <Step id={NIGHT_STEPS.close} n={4} title={t("nightStep.close")}>
        {!closed &&
          (confirming ? (
            <div className="actions" role="group" aria-label={t("nightCheck.closeIt")}>
              <span>{t("nightCheck.confirm", { date: date(night) })}</span>
              {needsPin && (
                <label>
                  <span>{t("nightCheck.pin")}</span>
                  <input
                    type="password"
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={6}
                    value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                  />
                </label>
              )}
              <button
                type="button"
                className="primary"
                disabled={busy || offline || !pinOk}
                onClick={() =>
                  void run(async () => {
                    const r = await api<{ z_report?: ZAtClose | null }>(
                      "POST",
                      `/v1/venues/${venueId}/nights/${night}/close`,
                      needsPin ? { pin } : {},
                    );
                    setSent(r.z_report ?? null);
                  })
                }
              >
                {t("nightCheck.closeIt")}
              </button>
              <button type="button" className="link" onClick={() => setConfirming(false)}>
                {t("night.back")}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="primary"
              disabled={busy || offline || blocking.length > 0}
              onClick={() => setConfirming(true)}
            >
              {t("nightCheck.closeIt")}
            </button>
          ))}
      </Step>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * Clock out {name} at [time] (U-15; D133): now, or back to their last punch, with a reason and the
 * manager's PIN in a PIN or badge session. The server writes it as a punch edit with who and why.
 */
function ClockOutForm({
  venueId,
  timeZone,
  person,
  needsPin,
  offline,
  onDone,
  onCancel,
}: {
  venueId: string;
  timeZone: string;
  person: { readonly id: string; readonly name: string; readonly since?: string };
  needsPin: boolean;
  offline: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t, time } = useT();
  const { now } = useClock();
  const [clock, setClock] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const local = now ? now.toZonedDateTimeISO(timeZone) : null;
  const nowHhmm = local ? local.toPlainTime().toString({ smallestUnit: "minute" }) : "";
  // The time picked, as an instant: today's local time, or yesterday's when it's later than now.
  const picked = (): Temporal.Instant | null => {
    if (!local || clock === null || clock === nowHhmm) return null;
    let at = local.withPlainTime(Temporal.PlainTime.from(clock));
    if (Temporal.ZonedDateTime.compare(at, local) > 0) at = at.subtract({ days: 1 });
    return at.toInstant();
  };
  const at = picked();
  const shown = at ?? now;
  const ok = reason.trim().length > 0 && (!needsPin || /^\d{4,6}$/.test(pin));
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("POST", `/v1/venues/${venueId}/team/${person.id}/clock-out`, {
        reason: reason.trim(),
        ...(at ? { at: at.toString() } : {}),
        ...(needsPin ? { pin } : {}),
      });
      onDone();
    } catch (e) {
      setError(
        e instanceof ApiCallError && e.status === 401
          ? t("nightCheck.wrongPin")
          : e instanceof ApiCallError && e.details["reason"] === "at"
            ? t("nightCheck.clockOutWhen", {
                time: person.since ? time(person.since, timeZone) : "",
              })
            : t("nightCheck.failed"),
      );
      setPin("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="night-clock-out"
      aria-label={t("nightCheck.clockOutWho", { name: person.name })}
      onSubmit={(e) => {
        e.preventDefault();
        if (ok && !busy && !offline) void submit();
      }}
    >
      <label>
        <span>{t("nightCheck.clockOutAt")}</span>
        <input
          type="time"
          value={clock ?? nowHhmm}
          onChange={(e) => setClock(e.target.value || null)}
        />
      </label>
      {person.since && (
        <p className="small muted">
          {t("nightCheck.lastPunch", { time: time(person.since, timeZone) })}
        </p>
      )}
      <label>
        <span>{t("nightCheck.clockOutReason")}</span>
        <input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="actions">
        <button type="button" className="chip" onClick={() => setReason(t("nightCheck.forgot"))}>
          {t("nightCheck.forgot")}
        </button>
      </div>
      {needsPin && (
        <label>
          <span>{t("nightCheck.pin")}</span>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
          />
        </label>
      )}
      <div className="actions">
        <button type="submit" className="primary" disabled={!ok || busy || offline}>
          {t("nightCheck.clockOutDo", {
            name: person.name,
            time: shown ? time(shown, timeZone) : "",
          })}
        </button>
        <button type="button" className="link" onClick={onCancel}>
          {t("night.back")}
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </form>
  );
}
