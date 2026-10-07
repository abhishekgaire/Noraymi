import { useCallback, useEffect, useState } from "react";
import type { MessageKey } from "@west4/shared";
import { api } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";

/**
 * Admin → Console · Emergency actions (M8-11; screens N39): what our staff
 * asked for on the emergency path, who asked, who on our side approved it,
 * why, and how it ended. Read-only for the owner: the second approver is ours,
 * and the owner was told by push and email the moment each one opened.
 */
interface EmergencyAction {
  readonly id: string;
  readonly action: string;
  readonly reason: string;
  readonly requested_by_name: string | null;
  readonly decided_by_name: string | null;
  readonly state: string;
}

const POLL_MS = 15_000;

export function EmergencyActions() {
  const { t } = useT();
  const { state } = useSession();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : "";
  const [rows, setRows] = useState<readonly EmergencyAction[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    if (!venueId) return;
    try {
      const r = await api<{ emergency_actions: EmergencyAction[] }>(
        "GET",
        `/v1/venues/${venueId}/emergency-actions`,
      );
      setRows(r.emergency_actions);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [venueId]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <section className="support-access" aria-labelledby="emergency-h">
      <h3 id="emergency-h">{t("emergency.title")}</h3>
      <p className="small">{t("emergency.intro")}</p>
      {failed && (
        <p className="error" role="alert">
          {t("shell.error.cantReach")}
        </p>
      )}
      {rows === null ? (
        !failed && <p role="status">{t("support.loading")}</p>
      ) : rows.length === 0 ? (
        <p className="hint">{t("emergency.empty")}</p>
      ) : (
        <ul className="support-list">
          {rows.map((e) => (
            <li
              key={e.id}
              aria-label={t(`emergency.action.${e.action}` as MessageKey)}
              className="support-grant"
            >
              <div>
                <strong>{t(`emergency.action.${e.action}` as MessageKey)}</strong>
                <span
                  className={e.state === "requested" || e.state === "failed" ? "warn" : "muted"}
                >
                  {t(`emergency.state.${e.state}` as MessageKey)}
                </span>
              </div>
              <p>{t("emergency.reason", { reason: e.reason })}</p>
              <p className="small">
                {t("emergency.askedBy", { name: e.requested_by_name ?? "—" })}
                {e.decided_by_name && ["approved", "done", "failed"].includes(e.state)
                  ? ` · ${t("emergency.approvedBy", { name: e.decided_by_name })}`
                  : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
