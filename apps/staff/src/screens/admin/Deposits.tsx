import { useCallback, useEffect, useState } from "react";
import { depositPolicyText } from "@west4/rules";
import type { DepositRule, PaySettings } from "@west4/shared";
import { useAdminDraft } from "../../admin/draft.js";
import { api } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";
import { Money } from "./Prices.js";

/**
 * Admin → Deposits & cancelling (M5-06; spec 03 · DepositRule; Payment flows ·
 * the booking page's Terms): the deposit, the refund cut-off, what a late
 * cancel and a no-show keep or charge, the grace minutes and the big-party
 * rule, saved through Save and publish (the rule-pack checks run on save).
 * Each save that changes the words guests read writes a new policy version;
 * the preview shows those words as they'll read, and the live version below.
 * With Online booking & deposits off, the section says so.
 */
const MODES = ["firstHour", "perPerson", "flat", "percent", "cardHold"] as const;
const LATE = ["keep", "half", "refund"] as const;
const NO_SHOW = ["keep", "firstHour", "nothing"] as const;

interface Version {
  readonly version: number;
  readonly text: string;
  readonly published_at: string;
  readonly published_by: string | null;
}

export function Deposits() {
  const { t } = useT();
  const { state } = useSession();
  const draft = useAdminDraft();
  const signedIn = state.status === "signedIn" ? state : null;
  const venueId = signedIn?.membership.venue_id ?? "";
  const bookingOn = signedIn?.membership.modules.online_booking !== "off";
  const [saved, setSaved] = useState<DepositRule | null>(null);
  const [pay, setPay] = useState<PaySettings | null>(null);
  const [live, setLive] = useState<Version | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const [d, p, v] = await Promise.all([
      api<{ value: DepositRule }>("GET", `/v1/venues/${venueId}/settings/deposit`),
      api<{ value: PaySettings }>("GET", `/v1/venues/${venueId}/settings/pay`),
      api<{ versions: Version[] }>("GET", `/v1/venues/${venueId}/policy-versions`),
    ]);
    setSaved(d.value);
    setPay(p.value);
    setLive(v.versions[0] ?? null);
  }, [venueId]);
  useEffect(() => {
    if (!venueId || !bookingOn) return;
    load().catch(() => setFailed(true));
  }, [venueId, bookingOn, load, draft.version]);

  const current = (draft.values["deposit"] as DepositRule | undefined) ?? saved;
  const set = (next: Partial<DepositRule>) =>
    current && draft.set("deposit", { ...current, ...next });
  const whole = (text: string, min = 0) => {
    const n = Number(text);
    return text !== "" && Number.isInteger(n) && n >= min ? n : null;
  };

  if (!bookingOn)
    return (
      <section className="deposits">
        <h2>{t("admin.section.deposits")}</h2>
        <p role="status">{t("deposits.bookingOff")}</p>
      </section>
    );

  const big = current?.bigParty ?? null;
  return (
    <section className="deposits">
      <h2>{t("admin.section.deposits")}</h2>
      {failed && (
        <p className="error" role="alert">
          {t("shell.error.cantReach")}
        </p>
      )}
      {current === null || pay === null ? (
        !failed && <p role="status">{t("shell.loading")}</p>
      ) : (
        <>
          <div className="invite-fields">
            <label className="check">
              <input
                type="checkbox"
                checked={current.on}
                onChange={(e) => set({ on: e.target.checked })}
              />{" "}
              {t("deposits.on")}
            </label>
            <label>
              <span>{t("deposits.mode")}</span>
              <select
                aria-label={t("deposits.mode")}
                value={current.mode}
                onChange={(e) => {
                  const mode = e.target.value as DepositRule["mode"];
                  set({
                    mode,
                    value:
                      mode === "percent" ? 50 : mode === "perPerson" || mode === "flat" ? 1000 : 0,
                  });
                }}
              >
                {MODES.map((m) => (
                  <option key={m} value={m}>
                    {t(`deposits.mode.${m}`)}
                  </option>
                ))}
              </select>
            </label>
            {(current.mode === "perPerson" || current.mode === "flat") && (
              <Money
                label={t(current.mode === "flat" ? "deposits.amount" : "deposits.perGuest")}
                cents={current.value}
                onChange={(value) => set({ value })}
              />
            )}
            {current.mode === "percent" && (
              <label>
                <span>{t("deposits.percent")}</span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  inputMode="numeric"
                  aria-label={t("deposits.percent")}
                  value={current.value}
                  onChange={(e) => {
                    const n = whole(e.target.value, 1);
                    if (n !== null && n <= 100) set({ value: n });
                  }}
                />
              </label>
            )}
            <label>
              <span>{t("deposits.refundHours")}</span>
              <input
                type="number"
                min={0}
                inputMode="numeric"
                aria-label={t("deposits.refundHours")}
                value={current.refundHours}
                onChange={(e) => {
                  const n = whole(e.target.value);
                  if (n !== null) set({ refundHours: n });
                }}
              />
            </label>
            <label>
              <span>{t("deposits.late")}</span>
              <select
                aria-label={t("deposits.late")}
                value={current.late}
                onChange={(e) => set({ late: e.target.value as DepositRule["late"] })}
              >
                {LATE.map((m) => (
                  <option key={m} value={m}>
                    {t(`deposits.late.${m}`)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{t("deposits.noShow")}</span>
              <select
                aria-label={t("deposits.noShow")}
                value={current.noShow}
                onChange={(e) => set({ noShow: e.target.value as DepositRule["noShow"] })}
              >
                {NO_SHOW.map((m) => (
                  <option key={m} value={m}>
                    {t(`deposits.noShow.${m}`)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{t("deposits.grace")}</span>
              <input
                type="number"
                min={0}
                inputMode="numeric"
                aria-label={t("deposits.grace")}
                value={current.graceMin}
                onChange={(e) => {
                  const n = whole(e.target.value);
                  if (n !== null) set({ graceMin: n });
                }}
              />
            </label>
          </div>

          <h3>{t("deposits.bigParty")}</h3>
          <div className="invite-fields">
            <label className="check">
              <input
                type="checkbox"
                checked={big !== null}
                onChange={(e) =>
                  set({
                    bigParty: e.target.checked
                      ? { fromGuests: 20, deposit: { kind: "flat", cents: 25000 }, refundHours: 24 }
                      : null,
                  })
                }
              />{" "}
              {t("deposits.bigParty.on")}
            </label>
            {big && (
              <>
                <label>
                  <span>{t("deposits.bigParty.from")}</span>
                  <input
                    type="number"
                    min={2}
                    inputMode="numeric"
                    aria-label={t("deposits.bigParty.from")}
                    value={big.fromGuests}
                    onChange={(e) => {
                      const n = whole(e.target.value, 2);
                      if (n !== null) set({ bigParty: { ...big, fromGuests: n } });
                    }}
                  />
                </label>
                {big.deposit.kind === "flat" && (
                  <Money
                    label={t("deposits.bigParty.amount")}
                    cents={big.deposit.cents}
                    onChange={(c) =>
                      set({ bigParty: { ...big, deposit: { kind: "flat", cents: c } } })
                    }
                  />
                )}
                <label>
                  <span>{t("deposits.bigParty.refundHours")}</span>
                  <input
                    type="number"
                    min={0}
                    inputMode="numeric"
                    aria-label={t("deposits.bigParty.refundHours")}
                    value={big.refundHours}
                    onChange={(e) => {
                      const n = whole(e.target.value);
                      if (n !== null) set({ bigParty: { ...big, refundHours: n } });
                    }}
                  />
                </label>
              </>
            )}
          </div>

          <h3>{t("deposits.policy")}</h3>
          <p className="small muted">{t("deposits.policy.hint")}</p>
          <div className="policy">
            {depositPolicyText(current, pay.gratuity)
              .split("\n")
              .map((line) => (
                <p key={line} data-guest-text>
                  {line}
                </p>
              ))}
          </div>
          {live && (
            <p className="small muted">
              {t("deposits.policy.live", { n: live.version })}
              {live.published_by ? ` · ${live.published_by}` : ""}
            </p>
          )}
        </>
      )}
    </section>
  );
}
