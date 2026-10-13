import { useCallback, useEffect, useState } from "react";
import { approvalModes, type ApprovalMode, type PosSettings } from "@west4/shared";
import { api, type ApiCallError } from "../../api.js";
import { useEvents } from "../../events.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";
import { TextingSwitches } from "./TextingSwitches.js";

/**
 * Admin → Features → Choices (F-03; D124; spec 03 · Choices): the settings an owner picks beside the
 * modules, each saved at once to its own key: drink tickets (`pos.printBarDrinkTickets`, also in
 * Admin → Bar POS), Texting (`texting.on`) and how approvals are decided (`approvals.mode`, the
 * owner's alone, F-04).
 */
export function FeatureChoices({ venueId }: { venueId: string }) {
  const { t } = useT();
  const { subscribe } = useEvents();
  const { state } = useSession();
  const isOwner = state.status === "signedIn" && state.membership.role === "owner";
  const [pos, setPos] = useState<PosSettings | null>(null);
  const [mode, setMode] = useState<ApprovalMode | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, a] = await Promise.all([
        api<{ value: PosSettings }>("GET", `/v1/venues/${venueId}/settings/pos`),
        api<{ value: { mode: ApprovalMode } }>("GET", `/v1/venues/${venueId}/settings/approvals`),
      ]);
      setPos(r.value);
      setMode(a.value.mode);
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

  const saveMode = async (next: ApprovalMode) => {
    setError(null);
    setMode(next);
    try {
      await api("PUT", `/v1/venues/${venueId}/settings/approvals`, { value: { mode: next } });
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
                <span>{pos.printBarDrinkTickets === true ? t("texts.on") : t("texts.off")}</span>
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
        <li className="module" aria-label={t("approvals.mode")}>
          <fieldset>
            <legend>
              <h4>{t("approvals.mode")}</h4>
            </legend>
            <p className="small muted">{t("approvals.mode.hint")}</p>
            {mode === null
              ? !failed && <span role="status">{t("shell.loading")}</span>
              : approvalModes.map((m) => (
                  <label key={m} className="check">
                    <input
                      type="radio"
                      name="approvals-mode"
                      checked={mode === m}
                      disabled={!isOwner}
                      onChange={() => void saveMode(m)}
                    />{" "}
                    {t(`approvals.mode.${m}`)}
                  </label>
                ))}
            {!isOwner && <p className="small muted">{t("approvals.mode.ownerOnly")}</p>}
          </fieldset>
        </li>
      </ul>
    </section>
  );
}
