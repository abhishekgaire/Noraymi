import { useCallback, useEffect, useState } from "react";
import {
  PUBLIC_FORM_DEFAULTS,
  type FormLimits,
  type PublicForm,
  type PublicFormsSettings,
} from "@west4/shared";
import { useAdminDraft } from "../../admin/draft.js";
import { api } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";

/**
 * Admin → Spam protection (M2-27, D109; spec 03 · publicForms; Security 8): the
 * daily limits on the guest web's public forms, per phone number, device and
 * network (IP address), counted per business date. The security check itself
 * (Cloudflare Turnstile, confirmed by the server) is always on and has no
 * settings. A form the venue hasn't set shows the defaults. Saved through Save
 * and publish, by an owner or a manager.
 */
const FORMS: readonly PublicForm[] = ["waitlist", "phoneCode"];
const FIELDS: readonly (keyof FormLimits)[] = ["perPhone", "perDevice", "perIp"];

export function PublicForms() {
  const { t } = useT();
  const { state } = useSession();
  const draft = useAdminDraft();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : "";
  const [saved, setSaved] = useState<PublicFormsSettings | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setSaved(
      (
        await api<{ value: PublicFormsSettings }>(
          "GET",
          `/v1/venues/${venueId}/settings/publicForms`,
        )
      ).value,
    );
  }, [venueId]);
  useEffect(() => {
    if (!venueId) return;
    load().catch(() => setFailed(true));
  }, [venueId, load, draft.version]);

  const current = (draft.values["publicForms"] as PublicFormsSettings | undefined) ?? saved;
  const limitsOf = (form: PublicForm): FormLimits => current?.[form] ?? PUBLIC_FORM_DEFAULTS[form];
  return (
    <section className="public-forms">
      <h2>{t("admin.section.publicForms")}</h2>
      <p className="muted">{t("publicForms.lead")}</p>
      {failed && (
        <p className="error" role="alert">
          {t("shell.error.cantReach")}
        </p>
      )}
      {current === null ? (
        !failed && <p role="status">{t("shell.loading")}</p>
      ) : (
        <div className="invite-fields">
          {FORMS.map((form) => (
            <fieldset key={form}>
              <legend>{t(`publicForms.${form}`)}</legend>
              {FIELDS.map((field) => (
                <label key={field}>
                  <span>{t(`publicForms.${field}`)}</span>
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    inputMode="numeric"
                    aria-label={`${t(`publicForms.${form}`)} · ${t(`publicForms.${field}`)}`}
                    value={limitsOf(form)[field]}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (!Number.isInteger(n) || n < 1 || n > 1000) return;
                      draft.set("publicForms", {
                        ...current,
                        [form]: { ...limitsOf(form), [field]: n },
                      });
                    }}
                  />
                  <span className="small muted">
                    {t("publicForms.perDay", { n: limitsOf(form)[field] })}
                  </span>
                </label>
              ))}
            </fieldset>
          ))}
          <p className="small muted">{t("publicForms.hint")}</p>
        </div>
      )}
    </section>
  );
}
