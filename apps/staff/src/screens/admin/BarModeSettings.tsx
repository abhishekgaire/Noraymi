import { useCallback, useEffect, useState } from "react";
import { cents, type BarModeSettings as Settings, type MessageKey } from "@west4/shared";
import { useAdminDraft } from "../../admin/draft.js";
import { api } from "../../api.js";
import { useT } from "../../i18n.js";
import { Money } from "./Prices.js";

/**
 * Admin → Bar mode's settings (M6-26; screens N34; Song systems and texts · Bar mode, Promotions;
 * spec 03 · BarModeSettings): the song price ("Song price · not set · songs need a drink credit"
 * while it's unset), "Buy a drink, get a song", free nights, songs per round, the singer alerts and
 * how many singers the Up next TV shows. Saved through Save and publish; every save runs the rule
 * pack's promotion checks, so "Buy a song, get a drink" (a free drink with a song) is refused with
 * the reason until the lawyer answers.
 */
const DAYS = [0, 1, 2, 3, 4, 5, 6] as const;

export function BarModeSettings({ venueId }: { venueId: string }) {
  const { t, money } = useT();
  const draft = useAdminDraft();
  const [saved, setSaved] = useState<Settings | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const b = await api<{ value: Settings }>("GET", `/v1/venues/${venueId}/settings/barMode`);
    setSaved(b.value);
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

  const bar = (draft.values["barMode"] as Settings | undefined) ?? saved;
  const set = (next: Partial<Settings>) => draft.set("barMode", { ...bar, ...next });

  /** A whole number of at least `min`; anything else is left as it was. */
  const whole = (label: string, value: number, min: number, onChange: (n: number) => void) => (
    <label>
      <span>{label}</span>
      <input
        type="number"
        min={min}
        inputMode="numeric"
        aria-label={label}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (e.target.value !== "" && Number.isInteger(n) && n >= min) onChange(n);
        }}
      />
    </label>
  );

  return (
    <div className="bar-mode-settings">
      <h3>{t("barMode.songs")}</h3>
      <p className="song-price">
        {bar.songPriceCents === null
          ? t("barMode.price.notSet")
          : t("barMode.price.set", { price: money(cents(bar.songPriceCents)) })}
      </p>
      <div className="invite-fields">
        <label className="check">
          <input
            type="checkbox"
            checked={bar.songPriceCents !== null}
            onChange={(e) => set({ songPriceCents: e.target.checked ? 0 : null })}
          />
          <span>{t("barMode.price.charge")}</span>
        </label>
        {bar.songPriceCents !== null && (
          <Money
            label={t("barMode.price.label")}
            cents={bar.songPriceCents}
            onChange={(c) => set({ songPriceCents: c })}
          />
        )}
      </div>
      <p className="small muted">{t("barMode.price.hint")}</p>

      <div className="invite-fields">
        <label className="check">
          <input
            type="checkbox"
            checked={bar.drinkCredit}
            onChange={(e) => set({ drinkCredit: e.target.checked })}
          />
          <span>{t("barMode.drinkCredit")}</span>
        </label>
      </div>
      <p className="small muted">{t("barMode.drinkCredit.hint")}</p>
      <div className="invite-fields">
        <label className="check">
          <input
            type="checkbox"
            checked={bar.freeDrinkWithSong === true}
            onChange={(e) => set({ freeDrinkWithSong: e.target.checked })}
          />
          <span>{t("barMode.freeDrink")}</span>
        </label>
      </div>
      <p className="small muted">{t("barMode.freeDrink.hint")}</p>

      <fieldset className="free-nights">
        <legend>{t("barMode.freeNights")}</legend>
        {DAYS.map((d) => (
          <label key={d} className="check">
            <input
              type="checkbox"
              checked={bar.freeNights.includes(d)}
              onChange={(e) =>
                set({
                  freeNights: e.target.checked
                    ? [...bar.freeNights, d].sort((a, b) => a - b)
                    : bar.freeNights.filter((x) => x !== d),
                })
              }
            />
            <span>{t(`day.${d}` as MessageKey)}</span>
          </label>
        ))}
      </fieldset>
      <p className="small muted">{t("barMode.freeNights.hint")}</p>

      <div className="invite-fields">
        {whole(t("barMode.perRound"), bar.songsPerRound, 1, (n) => set({ songsPerRound: n }))}
        {whole(t("barMode.upNextCount"), bar.upNextCount, 1, (n) => set({ upNextCount: n }))}
      </div>

      <h3>{t("barMode.alerts")}</h3>
      <div className="invite-fields">
        <label className="check">
          <input
            type="checkbox"
            checked={bar.alerts.beforeYou > 0}
            onChange={(e) =>
              set({ alerts: { ...bar.alerts, beforeYou: e.target.checked ? 2 : 0 } })
            }
          />
          <span>{t("barMode.alerts.before")}</span>
        </label>
        {bar.alerts.beforeYou > 0 &&
          whole(t("barMode.alerts.beforeCount"), bar.alerts.beforeYou, 1, (n) =>
            set({ alerts: { ...bar.alerts, beforeYou: n } }),
          )}
        <label className="check">
          <input
            type="checkbox"
            checked={bar.alerts.upNextText}
            onChange={(e) => set({ alerts: { ...bar.alerts, upNextText: e.target.checked } })}
          />
          <span>{t("barMode.alerts.upNext")}</span>
        </label>
      </div>
    </div>
  );
}
