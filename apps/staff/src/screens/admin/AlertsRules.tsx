import { useCallback, useEffect, useState } from "react";
import { roomSoundOn, roomSoundVolume, type AlertSettings } from "@west4/shared";
import { useAdminDraft } from "../../admin/draft.js";
import { api } from "../../api.js";
import { useT } from "../../i18n.js";
import { playRoomSound } from "../../room-sound.js";
import { useSession } from "../../session.js";

/**
 * Admin → Alerts & rules (M2-34; spec 03 · AlertSettings): how many minutes
 * before a room's booked end its tile turns amber. No "Ring the bar until
 * someone accepts" toggle. P-05: Sound when a room's time is up, its volume
 * and a button that plays it.
 */
export function AlertsRules() {
  const { t } = useT();
  const { state } = useSession();
  const draft = useAdminDraft();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : "";
  const [saved, setSaved] = useState<AlertSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    setSaved(
      (await api<{ value: AlertSettings }>("GET", `/v1/venues/${venueId}/settings/alerts`)).value,
    );
  }, [venueId]);
  useEffect(() => {
    if (!venueId) return;
    load().catch(() => setFailed(true));
  }, [venueId, load, draft.version]);
  const current = (draft.values["alerts"] as AlertSettings | undefined) ?? saved;
  return (
    <section className="alerts-rules">
      <h2>{t("admin.section.alerts")}</h2>
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
            <span>{t("alertsRules.roomEnding")}</span>
            <input
              type="number"
              min={0}
              max={120}
              aria-label={t("alertsRules.roomEnding")}
              value={current.roomEndingMin}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n >= 0 && n <= 120)
                  draft.set("alerts", { ...current, roomEndingMin: n });
              }}
            />
            <span className="small muted">{t("alertsRules.roomEnding.hint")}</span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={roomSoundOn(current)}
              onChange={(e) => draft.set("alerts", { ...current, roomSound: e.target.checked })}
            />
            <span>{t("alertsRules.sound")}</span>
          </label>
          <p className="small muted">{t("alertsRules.sound.hint")}</p>
          {roomSoundOn(current) && (
            <label>
              <span>{t("alertsRules.volume")}</span>
              <input
                type="range"
                min={0}
                max={100}
                step={10}
                aria-label={t("alertsRules.volume")}
                value={roomSoundVolume(current)}
                onChange={(e) =>
                  draft.set("alerts", { ...current, roomSoundVolume: Number(e.target.value) })
                }
              />
              <button
                type="button"
                className="secondary"
                onClick={() => playRoomSound(roomSoundVolume(current))}
              >
                {t("alertsRules.volume.test")}
              </button>
            </label>
          )}
        </div>
      )}
    </section>
  );
}
