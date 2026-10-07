import { useCallback, useEffect, useState } from "react";
import type { SafetySettings } from "@west4/shared";
import { useAdminDraft } from "../../admin/draft.js";
import { api } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";
import { IncidentLog } from "../Incidents.js";

/**
 * Admin → Safety (M2-28; screens N36; spec 03 · SafetySettings): the
 * occupancy limit (empty until the venue enters its own; never a made-up
 * number) and the share of it at which the board warns. Saved through Save
 * and publish. With Safety & ID records on, it also shows the help alert (who
 * gets it: every manager and owner; no settings keys of its own, M8-08) and
 * the incident log.
 */
export function Safety() {
  const { t } = useT();
  const { state } = useSession();
  const draft = useAdminDraft();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : "";
  const timeZone =
    state.status === "signedIn" ? state.membership.venue.time_zone : "America/New_York";
  const safetyOn = state.status === "signedIn" && state.membership.modules.safety !== "off";
  const [saved, setSaved] = useState<SafetySettings | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setSaved(
      (await api<{ value: SafetySettings }>("GET", `/v1/venues/${venueId}/settings/safety`)).value,
    );
  }, [venueId]);
  useEffect(() => {
    if (!venueId) return;
    load().catch(() => setFailed(true));
  }, [venueId, load, draft.version]);

  const current = (draft.values["safety"] as SafetySettings | undefined) ?? saved;
  return (
    <section className="safety">
      <h2>{t("admin.section.safety")}</h2>
      {failed && (
        <p className="error" role="alert">
          {t("shell.error.cantReach")}
        </p>
      )}
      {current === null ? (
        !failed && <p role="status">{t("shell.loading")}</p>
      ) : (
        <div className="invite-fields">
          <label>
            <span>{t("safety.limit")}</span>
            <input
              type="number"
              min={1}
              inputMode="numeric"
              aria-label={t("safety.limit")}
              placeholder={t("safety.limit.empty")}
              value={current.occupancyLimit ?? ""}
              onChange={(e) => {
                const n = Number(e.target.value);
                draft.set("safety", {
                  ...current,
                  occupancyLimit: e.target.value === "" || !Number.isInteger(n) || n < 1 ? null : n,
                });
              }}
            />
            <span className="small muted">{t("safety.limit.hint")}</span>
          </label>
          <label>
            <span>{t("safety.warnAt")}</span>
            <input
              type="number"
              min={1}
              max={100}
              inputMode="numeric"
              aria-label={t("safety.warnAt")}
              value={current.warnAtPct}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n >= 1 && n <= 100)
                  draft.set("safety", { ...current, warnAtPct: n });
              }}
            />
            <span className="small muted">{t("safety.warnAt.hint")}</span>
          </label>
        </div>
      )}
      {safetyOn && venueId && (
        <>
          <section aria-labelledby="safety-help">
            <h3 id="safety-help">{t("safety.help.title")}</h3>
            <p>{t("safety.help.who")}</p>
            <p className="small muted">{t("safety.help.how")}</p>
          </section>
          <section aria-labelledby="safety-log">
            <h3 id="safety-log">{t("incidents.log")}</h3>
            <IncidentLog venueId={venueId} timeZone={timeZone} />
          </section>
        </>
      )}
    </section>
  );
}
