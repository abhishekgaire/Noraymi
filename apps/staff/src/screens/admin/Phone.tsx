import { useCallback, useEffect, useState } from "react";
import type { PhoneSettings } from "@west4/shared";
import { useAdminDraft } from "../../admin/draft.js";
import { api, ApiCallError } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";
import { TwilioConnect } from "./TwilioConnect.js";

/**
 * Admin → Phone & texts (M2-10; spec 03 · PhoneSettings): the call number
 * (on the site, in texts, behind every Call button and "Call to book"), E.164,
 * saved through Save and publish; and Connect your Twilio account (T-02; D123):
 * texts come from the number of the venue's own Twilio account, picked there.
 */
const E164 = /^\+[1-9]\d{6,14}$/;

type CampaignStatus = "not_registered" | "pending" | "approved" | "rejected";
interface CampaignView {
  marketing: { status: CampaignStatus; checked_at: string | null } | null;
}

/** "+12122550011" as "+1 212 255 0011". */
export function formatPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `+1 ${m[1]} ${m[2]} ${m[3]}` : e164;
}

export function Phone() {
  const { t } = useT();
  const { state } = useSession();
  const draft = useAdminDraft();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : "";
  const [saved, setSaved] = useState<PhoneSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [raw, setRaw] = useState<Partial<Record<keyof PhoneSettings, string>>>({});
  const [campaign, setCampaign] = useState<CampaignView | null>(null);

  const load = useCallback(async () => {
    // A venue set up in the wizard (O-03) may have no numbers yet: empty, never filled in for it.
    const answer = await api<{ value: PhoneSettings }>(
      "GET",
      `/v1/venues/${venueId}/settings/phone`,
    ).catch((e: unknown) => {
      if (e instanceof ApiCallError && e.status === 404)
        return { value: { callNumber: "", textNumber: null } as unknown as PhoneSettings };
      throw e;
    });
    setSaved(answer.value);
    // The marketing campaign (M8-22), shown only while Marketing texts is on.
    setCampaign(await api<CampaignView>("GET", `/v1/venues/${venueId}/texts/campaign`));
  }, [venueId]);

  useEffect(() => {
    if (!venueId) return;
    load().catch(() => setFailed(true));
  }, [venueId, load, draft.version]);

  const current = (draft.values["phone"] as PhoneSettings | undefined) ?? saved;
  const field = (key: keyof PhoneSettings, label: "phone.callNumber") => {
    const value = raw[key] ?? current?.[key] ?? "";
    const ok = E164.test(value.replace(/[\s()-]/g, ""));
    return (
      <label key={key}>
        <span>{t(label)}</span>
        <input
          type="tel"
          aria-label={t(label)}
          value={value}
          aria-invalid={!ok}
          onChange={(e) => {
            setRaw((r) => ({ ...r, [key]: e.target.value }));
            const clean = e.target.value.replace(/[\s()-]/g, "");
            if (current && E164.test(clean)) draft.set("phone", { ...current, [key]: clean });
          }}
        />
        <span className="small muted">{t(`${label}.hint`)}</span>
        {ok ? (
          <span className="small">
            {t("phone.shows", { number: formatPhone(value.replace(/[\s()-]/g, "")) })}
          </span>
        ) : (
          <span className="small error">{t("phone.invalid")}</span>
        )}
      </label>
    );
  };

  return (
    <section className="phone">
      <h2>{t("admin.section.phone")}</h2>
      {failed && (
        <p className="error" role="alert">
          {t("shell.error.cantReach")}
        </p>
      )}
      {current === null ? (
        !failed && <p role="status">{t("shell.loading")}</p>
      ) : (
        <div className="invite-fields">{field("callNumber", "phone.callNumber")}</div>
      )}
      {venueId && <TwilioConnect venueId={venueId} />}
      {campaign?.marketing && (
        <dl className="campaign" data-testid="text-campaign">
          <dt>{t("phone.campaign.marketing")}</dt>
          <dd>{t(`phone.campaign.${campaign.marketing.status}`)}</dd>
        </dl>
      )}
    </section>
  );
}
