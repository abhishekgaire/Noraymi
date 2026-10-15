import { useCallback, useEffect, useState } from "react";
import { TEXTING_DEFAULTS, type MessageKey, type TextingSettings } from "@west4/shared";
import { api, type ApiCallError } from "../../api.js";
import { useEvents } from "../../events.js";
import { useT } from "../../i18n.js";

/**
 * Texting's switches (F-01; D124; spec 11 · Texting switch): the venue-wide Texting switch and the
 * texts that have no template (staff codes, the order-waiting alert, the singer's code, staff
 * replies), each saved at once to the `texting` key. STOP and HELP replies are shown on and locked:
 * the carriers require them. `only` shows just the venue-wide switch (Admin → Features → Choices).
 */
const STAFF_TEXTS = ["staffCodes", "orderWaiting", "singerCode", "staffReplies"] as const;

export function useTexting(venueId: string) {
  const [value, setValue] = useState<TextingSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const { subscribe } = useEvents();
  const load = useCallback(async () => {
    try {
      const r = await api<{ value: TextingSettings }>(
        "GET",
        `/v1/venues/${venueId}/settings/texting`,
      );
      setValue({ ...TEXTING_DEFAULTS, ...r.value });
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
  const save = async (next: TextingSettings) => {
    setValue(next);
    try {
      await api("PUT", `/v1/venues/${venueId}/settings/texting`, { value: next });
      return null;
    } catch (e) {
      await load();
      return (e as ApiCallError)?.message ?? "error";
    }
  };
  return { value, failed, save };
}

export function TextingSwitches({ venueId, only }: { venueId: string; only?: "on" }) {
  const { t } = useT();
  const { value, failed, save } = useTexting(venueId);
  const [error, setError] = useState<string | null>(null);

  if (failed && !value)
    return (
      <p className="error" role="alert">
        {t("shell.error.cantReach")}
      </p>
    );
  if (!value) return <p role="status">{t("shell.loading")}</p>;

  const flip = async (patch: Partial<TextingSettings>) => {
    setError(null);
    const problem = await save({ ...value, ...patch });
    if (problem) setError(t("texting.failed"));
  };

  const main = (
    <label className="switch-line">
      <input
        type="checkbox"
        aria-label={t("texting.switch")}
        checked={value.on}
        onChange={(e) => void flip({ on: e.target.checked })}
      />
      <span>{value.on ? t("texts.on") : t("texts.off")}</span>
    </label>
  );

  if (only === "on")
    return (
      <div className="module" aria-label={t("texting.switch")}>
        <div className="module-head">
          <div>
            <h3>{t("texting.switch")}</h3>
            <p className="small muted">{t("texting.switch.hint")}</p>
            <p className="small muted relates">{t("admin.relates.textingInChoices")}</p>
          </div>
          {main}
        </div>
        {error && (
          <p className="small error" role="alert">
            {error}
          </p>
        )}
      </div>
    );

  return (
    <div className="texting">
      <div className="module" aria-label={t("texting.switch")}>
        <div className="module-head">
          <div>
            <h3>{t("texting.switch")}</h3>
            <p className="small muted">
              {value.on ? t("texting.switch.hint") : t("texting.offNote")}
            </p>
            <p className="small muted relates">{t("admin.relates.textingInTexts")}</p>
          </div>
          {main}
        </div>
      </div>
      {error && (
        <p className="small error" role="alert">
          {error}
        </p>
      )}
      <h3>{t("texting.staffTexts")}</h3>
      <ul className="module-list texting-list">
        {STAFF_TEXTS.map((k) => {
          const name = t(`texting.${k}` as MessageKey);
          return (
            <li key={k} className="module" aria-label={name}>
              <div className="module-head">
                <div>
                  <h4>{name}</h4>
                  <p className="small muted">{t(`texting.${k}.off` as MessageKey)}</p>
                </div>
                <label className="switch-line">
                  <input
                    type="checkbox"
                    aria-label={`${name} · ${t("texts.on")}`}
                    checked={value.on && value[k]}
                    disabled={!value.on}
                    onChange={(e) => void flip({ [k]: e.target.checked })}
                  />
                  <span>{value.on && value[k] ? t("texts.on") : t("texts.off")}</span>
                </label>
              </div>
            </li>
          );
        })}
        <li className="module" aria-label={t("texting.stopHelp")}>
          <div className="module-head">
            <div>
              <h4>{t("texting.stopHelp")}</h4>
              <p className="small muted">{t("texting.stopHelp.hint")}</p>
            </div>
            <span className="pill">{t("texting.alwaysOn")}</span>
          </div>
        </li>
      </ul>
      <p className="small muted">{t("texting.emailsNote")}</p>
    </div>
  );
}
