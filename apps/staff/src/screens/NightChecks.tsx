import { useState } from "react";
import { Link } from "react-router";
import { api, ApiCallError } from "../api.js";
import { useT } from "../i18n.js";

/**
 * Close the night's checks and the close (M7-12; screens Night notes 1 and 6;
 * N17): each check before closing with a link to its fix, the clear-out
 * prompt ("Walk every room and the bar · no drinks left out"), the report
 * (a running X report until the close, the Z report after it, M7-13), and
 * Close the night after one confirmation. Slips not entered and tabs whose
 * capture failed are shown but don't hold the close up.
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
    | "capture_failed";
  readonly count: number;
  readonly blocking: boolean;
  readonly names: readonly string[];
  readonly link: string;
  readonly due_at?: string;
  readonly done?: { readonly by: string; readonly at: string } | null;
}

export function NightChecks({
  venueId,
  date: night,
  timeZone,
  checks,
  closed,
  postsTo,
  onChanged,
}: {
  venueId: string;
  date: string;
  timeZone: string;
  checks: readonly Check[];
  closed: { readonly closed_at: string; readonly z_number: number } | null;
  postsTo: string | null;
  onChanged: () => void;
}) {
  const { t, time, date } = useT();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
          : t("nightCheck.failed"),
      );
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };
  const clearOut = checks.find((c) => c.id === "clear_out");
  return (
    <section className="card night-checks" aria-labelledby="checks-title">
      <h2 id="checks-title">{t("nightCheck.title")}</h2>
      {closed && (
        <p role="status" className="notice">
          {t("nightCheck.closed", { time: time(closed.closed_at, timeZone) })}
        </p>
      )}
      <ul className="tips-shares">
        {checks
          .filter((c) => c.id !== "capture_failed" || c.count > 0)
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
              {(c.blocking || c.id === "slips" || c.id === "capture_failed") && (
                <Link to={c.link} className="link">
                  {t("nightCheck.fix")}
                </Link>
              )}
            </li>
          ))}
      </ul>
      {clearOut && !clearOut.done && !closed && (
        <div className="actions">
          <span className="small">{t("nightCheck.clearOutPrompt")}</span>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(() => api("POST", `/v1/venues/${venueId}/nights/${night}/clear-out`, {}))
            }
          >
            {t("nightCheck.clearOutDo")}
          </button>
        </div>
      )}
      {!closed &&
        (confirming ? (
          <div className="actions" role="group" aria-label={t("nightCheck.closeIt")}>
            <span>{t("nightCheck.confirm", { date: date(night) })}</span>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() =>
                void run(() => api("POST", `/v1/venues/${venueId}/nights/${night}/close`, {}))
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
            disabled={busy || blocking.length > 0}
            onClick={() => setConfirming(true)}
          >
            {t("nightCheck.closeIt")}
          </button>
        ))}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
