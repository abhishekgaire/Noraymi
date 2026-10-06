import { useCallback, useEffect, useState } from "react";
import { Temporal } from "@west4/shared";
import { api, ApiCallError } from "../../api.js";
import { useT } from "../../i18n.js";

/**
 * Admin → Team's "Time clock · tonight" (M7-11): the night's punches, each
 * with Edit. A new time needs a reason; the old one stays in the audit log
 * and the shift is worked out again. Nobody edits their own punches.
 */
interface Punch {
  readonly id: string;
  readonly name: string;
  readonly kind: "clock_in" | "clock_out" | "break_start" | "break_end";
  readonly duty: string | null;
  readonly at: string;
  readonly reason: string | null;
}

export function PunchesTonight({ venueId, timeZone }: { venueId: string; timeZone: string }) {
  const { t, time } = useT();
  const [punches, setPunches] = useState<readonly Punch[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [at, setAt] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setPunches((await api<{ punches: Punch[] }>("GET", `/v1/venues/${venueId}/punches`)).punches);
    } catch {
      setError(t("shell.error.cantReach"));
    }
  }, [venueId, t]);
  useEffect(() => void load(), [load]);

  const save = async (p: Punch) => {
    setError(null);
    const [h, m] = at.split(":").map(Number);
    const moved = Temporal.Instant.from(p.at)
      .toZonedDateTimeISO(timeZone)
      .with({ hour: h ?? 0, minute: m ?? 0, second: 0 });
    try {
      await api("PATCH", `/v1/venues/${venueId}/punches/${p.id}`, {
        at: moved.toInstant().toString(),
        reason: reason.trim(),
      });
      setEditing(null);
      await load();
    } catch (e) {
      setError(
        e instanceof ApiCallError && e.status === 403 ? t("punches.notYours") : t("punches.failed"),
      );
    }
  };
  return (
    <section className="punches-tonight" aria-labelledby="punches-title">
      <h3 id="punches-title">{t("punches.title")}</h3>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {punches === null && !error && <p role="status">{t("shell.loading")}</p>}
      {punches?.length === 0 && <p className="muted">{t("punches.none")}</p>}
      <ul className="tips-shares">
        {punches?.map((p) => (
          <li key={p.id} className="row">
            <span>
              {p.name} · {t(`punches.kind.${p.kind}`)} · {time(p.at, timeZone)}
              {p.reason ? <span className="small muted"> · {p.reason}</span> : null}
            </span>
            {editing === p.id ? (
              <span className="actions">
                <input
                  type="time"
                  aria-label={t("punches.newTime")}
                  value={at}
                  onChange={(e) => setAt(e.target.value)}
                />
                <input
                  aria-label={t("punches.reason")}
                  placeholder={t("punches.reason")}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                <button type="button" disabled={!at || !reason.trim()} onClick={() => void save(p)}>
                  {t("punches.save")}
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="link"
                onClick={() => {
                  setEditing(p.id);
                  setAt(
                    Temporal.Instant.from(p.at)
                      .toZonedDateTimeISO(timeZone)
                      .toPlainTime()
                      .toString({ smallestUnit: "minute" }),
                  );
                  setReason("");
                }}
              >
                {t("punches.edit")}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
