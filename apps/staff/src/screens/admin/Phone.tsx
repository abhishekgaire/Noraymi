import { useCallback, useEffect, useState } from "react";
import type { PhoneSettings } from "@west4/shared";
import { useAdminDraft } from "../../admin/draft.js";
import { api } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";

/**
 * Admin → Phone & texts (M2-10; spec 03 · PhoneSettings): the call number
 * (on the site, in texts, behind every Call button and "Call to book") and
 * the text number (the Twilio number texts come from), both E.164. Saved
 * through Save and publish.
 */
const E164 = /^\+[1-9]\d{6,14}$/;

type CampaignStatus = "not_registered" | "pending" | "approved" | "rejected";
interface CampaignView {
  number: string | null;
  service: { status: CampaignStatus; checked_at: string | null };
  marketing: { status: CampaignStatus; checked_at: string | null } | null;
  live: boolean;
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
    const answer = await api<{ value: PhoneSettings }>(
      "GET",
      `/v1/venues/${venueId}/settings/phone`,
    );
    setSaved(answer.value);
    // The 10DLC campaigns (M8-22): read only; set by our ops command once Twilio reports.
    setCampaign(await api<CampaignView>("GET", `/v1/venues/${venueId}/texts/campaign`));
  }, [venueId]);

  useEffect(() => {
    if (!venueId) return;
    load().catch(() => setFailed(true));
  }, [venueId, load, draft.version]);

  const current = (draft.values["phone"] as PhoneSettings | undefined) ?? saved;
  const field = (key: keyof PhoneSettings, label: "phone.callNumber" | "phone.textNumber") => {
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
        <div className="invite-fields">
          {field("callNumber", "phone.callNumber")}
          {field("textNumber", "phone.textNumber")}
        </div>
      )}
      {campaign && (
        <dl className="campaign" data-testid="text-campaign">
          <dt>{t("phone.campaign")}</dt>
          <dd>{t(`phone.campaign.${campaign.service.status}`)}</dd>
          {campaign.marketing && (
            <>
              <dt>{t("phone.campaign.marketing")}</dt>
              <dd>{t(`phone.campaign.${campaign.marketing.status}`)}</dd>
            </>
          )}
          <dd className={campaign.live ? "small" : "small muted"} role="status">
            {t(campaign.live ? "phone.campaign.live" : "phone.campaign.held")}
          </dd>
        </dl>
      )}
    </section>
  );
}
