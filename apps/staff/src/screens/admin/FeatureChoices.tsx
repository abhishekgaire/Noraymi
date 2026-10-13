import { useCallback, useEffect, useState } from "react";
import type { PosSettings } from "@west4/shared";
import { api, type ApiCallError } from "../../api.js";
import { useEvents } from "../../events.js";
import { useT } from "../../i18n.js";
import { TextingSwitches } from "./TextingSwitches.js";

/**
 * Admin → Features → Choices (F-03; D124; spec 03 · Choices): the settings an owner picks beside the
 * modules, each saved at once to its own key: drink tickets (`pos.printBarDrinkTickets`, also in
 * Admin → Bar POS) and Texting (`texting.on`). Approvals joins them in F-04.
 */
export function FeatureChoices({ venueId }: { venueId: string }) {
  const { t } = useT();
  const { subscribe } = useEvents();
  const [pos, setPos] = useState<PosSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ value: PosSettings }>("GET", `/v1/venues/${venueId}/settings/pos`);
      setPos(r.value);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [venueId]);
  useEffect(() => {
    if (venueId) void load();
  }, [venueId, load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (events.some((e) => e.type === "settings.changed")) void load();
      }),
    [subscribe, load],
  );

  const saveTickets = async (on: boolean) => {
    if (!pos) return;
    setError(null);
    const next = { ...pos, printBarDrinkTickets: on };
    setPos(next);
    try {
      await api("PUT", `/v1/venues/${venueId}/settings/pos`, { value: next });
    } catch (e) {
      setError((e as ApiCallError)?.message ?? t("texting.failed"));
      await load();
    }
  };

  return (
    <section className="feature-choices" aria-labelledby="feature-choices">
      <h3 id="feature-choices">{t("features.choices")}</h3>
      <p className="small muted">{t("features.choices.hint")}</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <ul className="module-list choice-list">
        <li className="module" aria-label={t("barPos.tickets.label")}>
          <div className="module-head">
            <div>
              <h4>{t("barPos.tickets.label")}</h4>
              <p className="small muted">{t("barPos.tickets.hint")}</p>
            </div>
            {pos ? (
              <label className="switch-line">
                <input
                  type="checkbox"
                  aria-label={t("barPos.tickets.label")}
                  checked={pos.printBarDrinkTickets === true}
                  onChange={(e) => void saveTickets(e.target.checked)}
                />
                <span>
                  {pos.printBarDrinkTickets === true ? t("texts.on") : t("texts.off")}
                </span>
              </label>
            ) : failed ? (
              <span className="error small">{t("shell.error.cantReach")}</span>
            ) : (
              <span role="status">{t("shell.loading")}</span>
            )}
          </div>
        </li>
        <li>
          <TextingSwitches venueId={venueId} only="on" />
        </li>
      </ul>
    </section>
  );
}
