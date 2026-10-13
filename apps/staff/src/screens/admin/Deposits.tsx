import { useCallback, useEffect, useState } from "react";
import { depositPolicyText } from "@west4/rules";
import { walkInTakes, walkInTakesOf, type DepositRule, type PaySettings } from "@west4/shared";
import { useAdminDraft } from "../../admin/draft.js";
import { api, type ApiCallError } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";
import { useModuleOn } from "../../useModule.js";
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
  const [payLoaded, setPayLoaded] = useState(false);
  const [live, setLive] = useState<Version | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    if (!bookingOn) {
      // The walk-in choice (D112) still applies with online booking off.
      const d = await api<{ value: DepositRule }>("GET", `/v1/venues/${venueId}/settings/deposit`);
      setSaved(d.value);
      return;
    }
    const [d, p, v] = await Promise.all([
      api<{ value: DepositRule }>("GET", `/v1/venues/${venueId}/settings/deposit`),
      // A new venue saves its payments in step 7 (O-09), after this one: none yet is no error.
      api<{ value: PaySettings }>("GET", `/v1/venues/${venueId}/settings/pay`).catch(
        (e: unknown) => {
          if ((e as ApiCallError)?.status === 404) return null;
          throw e;
        },
      ),
      api<{ versions: Version[] }>("GET", `/v1/venues/${venueId}/policy-versions`),
    ]);
    setSaved(d.value);
    setPay(p?.value ?? null);
    setPayLoaded(true);
    setLive(v.versions[0] ?? null);
  }, [venueId, bookingOn]);
  useEffect(() => {
    if (!venueId) return;
    load().catch(() => setFailed(true));
  }, [venueId, bookingOn, load, draft.version]);

  const current = (draft.values["deposit"] as DepositRule | undefined) ?? saved;
  const set = (next: Partial<DepositRule>) =>
    current && draft.set("deposit", { ...current, ...next });
  // Deposits on bookings switched off (D124): online bookings take nothing; the walk-in choice stays.
  const depositsOn = useModuleOn("deposits");
  const whole = (text: string, min = 0) => {
    const n = Number(text);
    return text !== "" && Number.isInteger(n) && n >= min ? n : null;
  };

  if (!bookingOn || !depositsOn)
    return (
      <section className="deposits">
        <h2>{t("admin.section.deposits")}</h2>
        <p role="status">{bookingOn ? t("deposits.depositsOff") : t("deposits.bookingOff")}</p>
        {failed && (
          <p className="error" role="alert">
            {t("shell.error.cantReach")}
          </p>
        )}
        {current && <WalkInChoice current={current} set={set} />}
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
      {current === null || !payLoaded ? (
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

          <WalkInChoice current={current} set={set} />

          <h3>{t("deposits.policy")}</h3>
          <p className="small muted">{t("deposits.policy.hint")}</p>
          {pay ? (
            <div className="policy">
              {depositPolicyText(current, pay.gratuity)
                .split("\n")
                .map((line) => (
                  <p key={line} data-guest-text>
                    {line}
                  </p>
                ))}
            </div>
          ) : (
            <p className="small muted" role="status">
              {t("deposits.policy.afterPayments")}
            </p>
          )}
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

/**
 * What a walk-in check-in takes (D112): a deposit (the default, West 4), a card
 * on the room's tab (saved on the reader, nothing charged) or nothing. Online
 * bookings keep the deposit above.
 */
function WalkInChoice({
  current,
  set,
}: {
  current: DepositRule;
  set: (next: Partial<DepositRule>) => void;
}) {
  const { t } = useT();
  const cardBehindBarOn = useModuleOn("card_behind_bar");
  const value = walkInTakesOf(current);
  return (
    <>
      <h3>{t("deposits.walkIn")}</h3>
      <p className="small muted">{t("deposits.walkIn.hint")}</p>
      <div className="invite-fields" role="radiogroup" aria-label={t("deposits.walkIn")}>
        {walkInTakes
          // Keep the card behind the bar shows only while its switch is on, or while it's chosen (D124).
          .filter((w) => w !== "cardBehindBar" || cardBehindBarOn || value === w)
          .map((w) => (
            <label key={w} className="check">
              <input
                type="radio"
                name="walk-in-takes"
                checked={value === w}
                onChange={() => set({ walkIn: w })}
              />{" "}
              {t(`deposits.walkIn.${w}`)}
            </label>
          ))}
      </div>
    </>
  );
}
