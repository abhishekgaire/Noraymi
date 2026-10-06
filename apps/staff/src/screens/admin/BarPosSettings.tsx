import { useCallback, useEffect, useState } from "react";
import { tabConsentLine, type PosSettings, type TabSettings } from "@west4/shared";
import { useAdminDraft } from "../../admin/draft.js";
import { agingSentence } from "../../aging.js";
import { api } from "../../api.js";
import { useT } from "../../i18n.js";
import { Money } from "./Prices.js";

/**
 * Admin → Bar POS, after the layout (M6-25; screens N33; Staff screens and the
 * bar POS · Admin → Bar POS): the reason-only limits, the locks, the tip
 * path, order aging (read back as the escalation sentence) and the tab
 * settings with the consent line they make. Saved through Save and publish,
 * and live at once; saving the tab settings writes the consent line's new
 * version, and tabs already open keep theirs. There's no "Ring the bar until
 * someone accepts" toggle: the aging times, the chime and Mute replace it.
 */
export function BarPosSettings({ venueId }: { venueId: string }) {
  const { t } = useT();
  const draft = useAdminDraft();
  const [saved, setSaved] = useState<{ pos: PosSettings; tabs: TabSettings } | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const [p, tb] = await Promise.all([
      api<{ value: PosSettings }>("GET", `/v1/venues/${venueId}/settings/pos`),
      api<{ value: TabSettings }>("GET", `/v1/venues/${venueId}/settings/tabs`),
    ]);
    setSaved({ pos: p.value, tabs: tb.value });
  }, [venueId]);
  useEffect(() => {
    if (!venueId) return;
    load().catch(() => setFailed(true));
  }, [venueId, load, draft.version]);

  if (failed)
    return (
      <p className="error" role="alert">
        {t("shell.error.cantReach")}
      </p>
    );
  if (!saved) return <p role="status">{t("shell.loading")}</p>;

  const pos = (draft.values["pos"] as PosSettings | undefined) ?? saved.pos;
  const tabs = (draft.values["tabs"] as TabSettings | undefined) ?? saved.tabs;
  const setPos = (next: Partial<PosSettings>) => draft.set("pos", { ...pos, ...next });
  const setAging = (next: Partial<PosSettings["orderAging"]>) =>
    setPos({ orderAging: { ...pos.orderAging, ...next } });
  const setTabs = (next: Partial<TabSettings>) => draft.set("tabs", { ...tabs, ...next });
  const sentence = agingSentence({ ...pos.orderAging, chime: pos.chime });

  /** A whole number of `unit` seconds, 1 or more; anything else is left as it was. */
  const whole = (label: string, value: number, unit: number, onChange: (sec: number) => void) => (
    <label>
      <span>{label}</span>
      <input
        type="number"
        min={1}
        inputMode="numeric"
        aria-label={label}
        value={value / unit}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (e.target.value !== "" && Number.isInteger(n) && n >= 1) onChange(n * unit);
        }}
      />
    </label>
  );

  return (
    <div className="bar-pos-settings">
      <p className="small muted">{t("barPos.now")}</p>

      <h3>{t("barPos.limits")}</h3>
      <div className="invite-fields">
        <Money
          label={t("barPos.limits.each")}
          cents={pos.reasonOnly.eachCents}
          onChange={(c) => setPos({ reasonOnly: { ...pos.reasonOnly, eachCents: c } })}
        />
        <Money
          label={t("barPos.limits.perShift")}
          cents={pos.reasonOnly.perShiftCents}
          onChange={(c) => setPos({ reasonOnly: { ...pos.reasonOnly, perShiftCents: c } })}
        />
      </div>
      <p className="small muted">{t("barPos.limits.hint")}</p>

      <h3>{t("barPos.locks")}</h3>
      <div className="invite-fields">
        {whole(t("barPos.locks.idle"), pos.idleLockMin, 1, (n) => setPos({ idleLockMin: n }))}
        {whole(t("barPos.locks.wipe"), pos.wipeLockSec, 1, (n) => setPos({ wipeLockSec: n }))}
      </div>

      <h3>{t("barPos.tip")}</h3>
      <div className="invite-fields">
        <label>
          <span>{t("barPos.tip.label")}</span>
          <select
            aria-label={t("barPos.tip.label")}
            value={pos.barTabTip}
            onChange={(e) => setPos({ barTabTip: e.target.value as PosSettings["barTabTip"] })}
          >
            <option value="reader">{t("barPos.tip.reader")}</option>
            <option value="slip">{t("barPos.tip.slip")}</option>
          </select>
        </label>
      </div>
      <p className="small muted">{t("barPos.tip.hint")}</p>

      <h3>{t("barPos.aging")}</h3>
      <div className="invite-fields">
        {whole(t("barPos.aging.phones"), pos.orderAging.phonesSec, 1, (n) =>
          setAging({ phonesSec: n }),
        )}
        {whole(t("barPos.aging.amber"), pos.orderAging.amberSec, 60, (n) =>
          setAging({ amberSec: n }),
        )}
        {whole(t("barPos.aging.pink"), pos.orderAging.pinkSec, 60, (n) => setAging({ pinkSec: n }))}
        {whole(t("barPos.aging.call"), pos.orderAging.callSec, 60, (n) => setAging({ callSec: n }))}
        {whole(t("barPos.aging.mute"), pos.muteSec, 1, (n) => setPos({ muteSec: n }))}
        <label className="check">
          <input
            type="checkbox"
            checked={pos.chime}
            onChange={(e) => setPos({ chime: e.target.checked })}
          />
          <span>{t("barPos.aging.chime")}</span>
        </label>
      </div>
      <p className="escalation" aria-label={t("barPos.aging")}>
        {t(sentence.key, sentence.params)}
      </p>

      <h3>{t("barPos.tabs")}</h3>
      <div className="invite-fields">
        <Money
          label={t("barPos.tabs.hold")}
          cents={tabs.openingHoldCents}
          onChange={(c) => setTabs({ openingHoldCents: c })}
        />
        <Money
          label={t("barPos.tabs.flag")}
          cents={tabs.flagOverCents}
          onChange={(c) => setTabs({ flagOverCents: c })}
        />
        <label>
          <span>{t("barPos.tabs.cutOff")}</span>
          <input
            type="time"
            aria-label={t("barPos.tabs.cutOff")}
            value={tabs.cutOffAt}
            onChange={(e) => {
              if (/^\d{2}:\d{2}$/.test(e.target.value)) setTabs({ cutOffAt: e.target.value });
            }}
          />
        </label>
      </div>
      <p className="small">{t("barPos.tabs.consent")}</p>
      <blockquote className="consent-line" data-guest-text>
        {tabConsentLine(tabs)}
      </blockquote>
      <p className="small muted">{t("barPos.tabs.consentHint")}</p>
    </div>
  );
}
