import { useCallback, useEffect, useState } from "react";
import type { KitchenSettings } from "@west4/shared";
import { useAdminDraft } from "../../admin/draft.js";
import { api } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";

/**
 * Admin → Kitchen (K-01; spec 16 · The Kitchen module): the `kitchen` settings key, saved through
 * Save and publish. The allergy notice is written in English and Spanish (its words are the
 * lawyer's, so the field starts empty and the module stays off until both are set), the kitchen's
 * last order time (empty: food follows room ordering), and how many minutes staff-rung food may sit
 * Not sent before the reminder (1 to 60, 5 by default). Shown wherever the Console allows Kitchen &
 * food, on or off, because the notice has to be set before the switch turns on.
 */
export function Kitchen() {
  const { t } = useT();
  const { state } = useSession();
  const draft = useAdminDraft();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : "";
  const [saved, setSaved] = useState<KitchenSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<{ en: string; es: string } | null>(null);
  const [minutes, setMinutes] = useState<string | null>(null);

  const load = useCallback(async () => {
    const value = (
      await api<{ value: KitchenSettings }>("GET", `/v1/venues/${venueId}/settings/kitchen`)
    ).value;
    setSaved(value);
    setNotice(null);
    setMinutes(null);
  }, [venueId]);
  useEffect(() => {
    if (!venueId) return;
    load().catch(() => setFailed(true));
  }, [venueId, load, draft.version]);

  const current = (draft.values["kitchen"] as KitchenSettings | undefined) ?? saved;
  const text = notice ?? {
    en: current?.allergyNotice?.en ?? "",
    es: current?.allergyNotice?.es ?? "",
  };
  const halfWritten = (text.en.trim() === "") !== (text.es.trim() === "");
  const minutesText = minutes ?? String(current?.unsentWarnMin ?? "");
  const minutesValid = /^\d+$/.test(minutesText) && +minutesText >= 1 && +minutesText <= 60;

  const writeNotice = (next: { en: string; es: string }) => {
    setNotice(next);
    if (!current) return;
    const en = next.en.trim();
    const es = next.es.trim();
    if (en === "" && es === "") draft.set("kitchen", { ...current, allergyNotice: null });
    else if (en !== "" && es !== "")
      draft.set("kitchen", { ...current, allergyNotice: { en: next.en, es: next.es } });
  };

  return (
    <section className="kitchen-settings">
      <h2>{t("admin.section.kitchen")}</h2>
      <p className="muted">{t("admin.hint.kitchen")}</p>
      {failed && (
        <p className="error" role="alert">
          {t("shell.error.cantReach")}
        </p>
      )}
      {current === null ? (
        !failed && <p role="status">{t("shell.loading")}</p>
      ) : (
        <div className="invite-fields">
          <fieldset>
            <legend>{t("kitchen.admin.notice")}</legend>
            {current.allergyNotice === null && (
              <p className="notice" role="status">
                {t("kitchen.admin.notice.notSet")}
              </p>
            )}
            <label>
              <span>{t("kitchen.admin.notice.en")}</span>
              <textarea
                rows={3}
                maxLength={1000}
                aria-label={`${t("kitchen.admin.notice")} · ${t("kitchen.admin.notice.en")}`}
                value={text.en}
                onChange={(e) => writeNotice({ ...text, en: e.target.value })}
              />
            </label>
            <label>
              <span>{t("kitchen.admin.notice.es")}</span>
              <textarea
                rows={3}
                maxLength={1000}
                aria-label={`${t("kitchen.admin.notice")} · ${t("kitchen.admin.notice.es")}`}
                value={text.es}
                onChange={(e) => writeNotice({ ...text, es: e.target.value })}
              />
            </label>
            {halfWritten ? (
              <p className="error small" role="alert">
                {t("kitchen.admin.notice.bothLanguages")}
              </p>
            ) : (
              <span className="small muted">{t("kitchen.admin.notice.hint")}</span>
            )}
          </fieldset>
          <label>
            <span>{t("kitchen.admin.lastOrder")}</span>
            <input
              type="time"
              aria-label={t("kitchen.admin.lastOrder")}
              value={current.lastOrder ?? ""}
              onChange={(e) =>
                draft.set("kitchen", {
                  ...current,
                  lastOrder: /^\d\d:\d\d$/.test(e.target.value) ? e.target.value : null,
                })
              }
            />
            <span className="small muted">{t("kitchen.admin.lastOrder.hint")}</span>
          </label>
          <label>
            <span>{t("kitchen.admin.unsentWarnMin")}</span>
            <input
              type="number"
              min={1}
              max={60}
              inputMode="numeric"
              aria-label={t("kitchen.admin.unsentWarnMin")}
              aria-invalid={!minutesValid}
              value={minutesText}
              onChange={(e) => {
                setMinutes(e.target.value);
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n >= 1 && n <= 60)
                  draft.set("kitchen", { ...current, unsentWarnMin: n });
              }}
            />
            <span className={minutesValid ? "small muted" : "small error"}>
              {t("kitchen.admin.unsentWarnMin.hint")}
            </span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={current.afterOutage !== false}
              onChange={(e) => draft.set("kitchen", { ...current, afterOutage: e.target.checked })}
            />
            <span>{t("kitchen.admin.afterOutage")}</span>
            <span className="small muted">{t("kitchen.admin.afterOutage.hint")}</span>
          </label>
        </div>
      )}
    </section>
  );
}
