import { useCallback, useEffect, useState } from "react";
import type { PriceSettings } from "@west4/shared";
import { useAdminDraft } from "../../admin/draft.js";
import { api } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";

/**
 * Admin → Hours & prices, the `prices` key (M2-34; spec 03 · PriceSettings):
 * the rate in the venue's mode, the billing step and its rounding, minimum
 * guests, the first-hour minimum, time bands, the VIP rate, booking limits and
 * the damage fee. Amounts are typed in dollars and kept as whole cents.
 * Minimum spend shows off; M4 edits it. Saved through Save and publish.
 */
type Rate = PriceSettings["rate"];
type Band = PriceSettings["bands"][number];
const STEPS = [1, 15, 30, 60] as const;
const ROUNDING = ["up", "nearest", "down"] as const;
const DAYS = [1, 2, 3, 4, 5, 6, 0] as const;

/** "10.50" as 1050 cents, without floats; null when it isn't a dollar amount. */
export function dollarsToCents(text: string): number | null {
  const m = /^\s*\$?(\d{1,6})(?:\.(\d{1,2}))?\s*$/.exec(text);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}
const centsText = (cents: number) =>
  `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
const hhmm = (min: number) =>
  `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const minutesOf = (value: string) => {
  const [h, m] = value.split(":").map(Number) as [number, number];
  return h * 60 + m;
};

export function Money({
  label,
  cents,
  onChange,
}: {
  label: string;
  cents: number;
  onChange: (cents: number) => void;
}) {
  const [text, setText] = useState(centsText(cents));
  useEffect(() => setText(centsText(cents)), [cents]);
  const ok = dollarsToCents(text) !== null;
  return (
    <label>
      <span>{label}</span>
      <input
        inputMode="decimal"
        aria-label={label}
        value={text}
        aria-invalid={!ok}
        onChange={(e) => {
          setText(e.target.value);
          const c = dollarsToCents(e.target.value);
          if (c !== null) onChange(c);
        }}
      />
    </label>
  );
}

export function Prices() {
  const { t } = useT();
  const { state } = useSession();
  const draft = useAdminDraft();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : "";
  const [saved, setSaved] = useState<PriceSettings | null>(null);
  const [rooms, setRooms] = useState<{ id: string; name: string; size_tier: string }[]>([]);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const [p, r] = await Promise.all([
      api<{ value: PriceSettings }>("GET", `/v1/venues/${venueId}/settings/prices`),
      api<{ rooms: { id: string; name: string; size_tier: string }[] }>(
        "GET",
        `/v1/venues/${venueId}/rooms`,
      ),
    ]);
    setSaved(p.value);
    setRooms(r.rooms);
  }, [venueId]);
  useEffect(() => {
    if (!venueId) return;
    load().catch(() => setFailed(true));
  }, [venueId, load, draft.version]);

  const current = (draft.values["prices"] as PriceSettings | undefined) ?? saved;
  if (failed)
    return (
      <p className="error" role="alert">
        {t("shell.error.cantReach")}
      </p>
    );
  if (!current) return <p role="status">{t("shell.loading")}</p>;
  const set = (change: Partial<PriceSettings>) => draft.set("prices", { ...current, ...change });
  const tiers = [...new Set(rooms.map((r) => r.size_tier))];

  const rateEditor = (rate: Rate, onRate: (r: Rate) => void, prefix: string) => (
    <div className="invite-fields">
      <label>
        <span>{t("prices.mode")}</span>
        <select
          aria-label={`${prefix}${t("prices.mode")}`}
          value={rate.mode}
          onChange={(e) => {
            const mode = e.target.value as Rate["mode"];
            if (mode === "perPerson") onRate({ mode, perPersonCents: 1000 });
            else if (mode === "basePlusExtra")
              onRate({ mode, baseCents: 4000, baseGuests: 4, extraCents: 1000 });
            else onRate({ mode, bySizeCents: Object.fromEntries(tiers.map((x) => [x, 0])) });
          }}
        >
          <option value="perPerson">{t("prices.mode.perPerson")}</option>
          <option value="basePlusExtra">{t("prices.mode.basePlusExtra")}</option>
          <option value="flatBySize">{t("prices.mode.flatBySize")}</option>
        </select>
      </label>
      {rate.mode === "perPerson" && (
        <Money
          label={`${prefix}${t("prices.perPerson")}`}
          cents={rate.perPersonCents}
          onChange={(c) => onRate({ ...rate, perPersonCents: c })}
        />
      )}
      {rate.mode === "basePlusExtra" && (
        <>
          <Money
            label={`${prefix}${t("prices.base")}`}
            cents={rate.baseCents}
            onChange={(c) => onRate({ ...rate, baseCents: c })}
          />
          <label>
            <span>{t("prices.baseGuests")}</span>
            <input
              type="number"
              min={1}
              aria-label={`${prefix}${t("prices.baseGuests")}`}
              value={rate.baseGuests}
              onChange={(e) =>
                onRate({ ...rate, baseGuests: Math.max(1, Number(e.target.value) || 1) })
              }
            />
          </label>
          <Money
            label={`${prefix}${t("prices.extra")}`}
            cents={rate.extraCents}
            onChange={(c) => onRate({ ...rate, extraCents: c })}
          />
        </>
      )}
      {rate.mode === "flatBySize" &&
        tiers.map((tier) => (
          <Money
            key={tier}
            label={`${prefix}${t("prices.flat", { tier })}`}
            cents={rate.bySizeCents[tier] ?? 0}
            onChange={(c) => onRate({ ...rate, bySizeCents: { ...rate.bySizeCents, [tier]: c } })}
          />
        ))}
    </div>
  );
  const billingEditor = (
    billing: PriceSettings["billing"],
    onBilling: (b: PriceSettings["billing"]) => void,
    prefix: string,
  ) => (
    <div className="invite-fields">
      <label>
        <span>{t("prices.step")}</span>
        <select
          aria-label={`${prefix}${t("prices.step")}`}
          value={billing.incrementMin}
          onChange={(e) =>
            onBilling({
              ...billing,
              incrementMin: Number(e.target.value) as (typeof STEPS)[number],
            })
          }
        >
          {STEPS.map((s) => (
            <option key={s} value={s}>
              {s === 1 ? t("prices.step.minute") : t("prices.step.minutes", { min: s })}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>{t("prices.rounding")}</span>
        <select
          aria-label={`${prefix}${t("prices.rounding")}`}
          value={billing.rounding}
          onChange={(e) =>
            onBilling({ ...billing, rounding: e.target.value as (typeof ROUNDING)[number] })
          }
        >
          {ROUNDING.map((r) => (
            <option key={r} value={r}>
              {t(`prices.rounding.${r}`)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );

  return (
    <div className="prices">
      <h3>{t("prices.title")}</h3>
      {rateEditor(current.rate, (rate) => set({ rate }), "")}
      {billingEditor(current.billing, (billing) => set({ billing }), "")}
      <div className="invite-fields">
        <label>
          <span>{t("prices.minWeeknight")}</span>
          <input
            type="number"
            min={1}
            aria-label={t("prices.minWeeknight")}
            value={current.minGuests.weeknight}
            onChange={(e) =>
              set({
                minGuests: {
                  ...current.minGuests,
                  weeknight: Math.max(1, Number(e.target.value) || 1),
                },
              })
            }
          />
        </label>
        <label>
          <span>{t("prices.minFriSat")}</span>
          <input
            type="number"
            min={1}
            aria-label={t("prices.minFriSat")}
            value={current.minGuests.friSat}
            onChange={(e) =>
              set({
                minGuests: {
                  ...current.minGuests,
                  friSat: Math.max(1, Number(e.target.value) || 1),
                },
              })
            }
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={current.firstHourMinimum}
            onChange={(e) => set({ firstHourMinimum: e.target.checked })}
          />
          {t("prices.firstHour")}
        </label>
      </div>

      <h4>{t("prices.bands")}</h4>
      {current.bands.length === 0 && <p className="empty">{t("prices.bands.none")}</p>}
      {current.bands.map((band, i) => {
        const setBand = (b: Band) => set({ bands: current.bands.map((x, j) => (j === i ? b : x)) });
        const prefix = `${band.name}: `;
        return (
          <fieldset key={i} className="band">
            <legend>{band.name}</legend>
            <label>
              <span>{t("prices.band.name")}</span>
              <input
                aria-label={`${prefix}${t("prices.band.name")}`}
                value={band.name}
                onChange={(e) => e.target.value && setBand({ ...band, name: e.target.value })}
              />
            </label>
            <div className="actions">
              {DAYS.map((d) => (
                <label key={d} className="check">
                  <input
                    type="checkbox"
                    checked={band.days.includes(d)}
                    onChange={(e) =>
                      setBand({
                        ...band,
                        days: e.target.checked
                          ? [...band.days, d].sort((a, b) => a - b)
                          : band.days.filter((x) => x !== d),
                      })
                    }
                  />
                  {t(`day.${d}` as never)}
                </label>
              ))}
            </div>
            <div className="invite-fields">
              <label>
                <span>{t("prices.band.from")}</span>
                <input
                  type="time"
                  aria-label={`${prefix}${t("prices.band.from")}`}
                  value={hhmm(band.fromMin)}
                  onChange={(e) => setBand({ ...band, fromMin: minutesOf(e.target.value) })}
                />
              </label>
              <label>
                <span>{t("prices.band.to")}</span>
                <input
                  type="time"
                  aria-label={`${prefix}${t("prices.band.to")}`}
                  value={hhmm(band.toMin)}
                  onChange={(e) => {
                    const m = minutesOf(e.target.value);
                    // Past midnight runs on into the night (24:00 and later, up to the 6 AM cutover).
                    setBand({ ...band, toMin: m <= band.fromMin ? m + 1440 : m });
                  }}
                />
              </label>
            </div>
            {rateEditor(band.rate, (rate) => setBand({ ...band, rate }), prefix)}
            {billingEditor(band.billing, (billing) => setBand({ ...band, billing }), prefix)}
            <button
              type="button"
              className="link"
              onClick={() => set({ bands: current.bands.filter((_, j) => j !== i) })}
            >
              {t("prices.band.remove")}
            </button>
          </fieldset>
        );
      })}
      <button
        type="button"
        className="secondary"
        onClick={() =>
          set({
            bands: [
              ...current.bands,
              {
                name: t("prices.band.default", { n: current.bands.length + 1 }),
                days: [5, 6],
                fromMin: 22 * 60,
                toMin: 26 * 60,
                rate: current.rate,
                billing: { incrementMin: 15, rounding: "up" },
              },
            ],
          })
        }
      >
        {t("prices.band.add")}
      </button>

      <h4>{t("prices.vip")}</h4>
      <div className="invite-fields">
        <label className="check">
          <input
            type="checkbox"
            checked={current.vip !== null}
            onChange={(e) =>
              set({
                vip: e.target.checked
                  ? {
                      roomIds: rooms.filter((r) => r.size_tier === "vip").map((r) => r.id),
                      hourlyCents: 0,
                      fromGuests: 1,
                    }
                  : null,
              })
            }
          />
          {t("prices.vip.on")}
        </label>
        {current.vip && (
          <>
            {rooms
              .filter((r) => r.size_tier === "vip" || current.vip!.roomIds.includes(r.id))
              .map((r) => (
                <label key={r.id} className="check">
                  <input
                    type="checkbox"
                    checked={current.vip!.roomIds.includes(r.id)}
                    onChange={(e) =>
                      set({
                        vip: {
                          ...current.vip!,
                          roomIds: e.target.checked
                            ? [...current.vip!.roomIds, r.id]
                            : current.vip!.roomIds.filter((x) => x !== r.id),
                        },
                      })
                    }
                  />
                  {r.name}
                </label>
              ))}
            <Money
              label={t("prices.vip.hourly")}
              cents={current.vip.hourlyCents}
              onChange={(c) => set({ vip: { ...current.vip!, hourlyCents: c } })}
            />
            <label>
              <span>{t("prices.vip.from")}</span>
              <input
                type="number"
                min={1}
                aria-label={t("prices.vip.from")}
                value={current.vip.fromGuests}
                onChange={(e) =>
                  set({
                    vip: { ...current.vip!, fromGuests: Math.max(1, Number(e.target.value) || 1) },
                  })
                }
              />
            </label>
          </>
        )}
      </div>

      <h4>{t("prices.limits")}</h4>
      <div className="invite-fields">
        {(["minHours", "maxHours"] as const).map((k) => (
          <label key={k}>
            <span>{t(`prices.${k}`)}</span>
            <input
              type="number"
              min={0.5}
              step={0.5}
              aria-label={t(`prices.${k}`)}
              value={current.booking[k]}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (n > 0) set({ booking: { ...current.booking, [k]: n } });
              }}
            />
          </label>
        ))}
        <label>
          <span>{t("prices.maxGuests")}</span>
          <input
            type="number"
            min={1}
            aria-label={t("prices.maxGuests")}
            value={current.booking.maxGuests}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n > 0)
                set({ booking: { ...current.booking, maxGuests: n } });
            }}
          />
        </label>
        <label>
          <span>{t("prices.slots")}</span>
          <input
            aria-label={t("prices.slots")}
            defaultValue={current.booking.startSlots.join(", ")}
            onBlur={(e) => {
              const slots = e.target.value.split(/[,\s]+/).filter((x) => /^\d{2}:\d{2}$/.test(x));
              set({ booking: { ...current.booking, startSlots: slots } });
            }}
          />
          <span className="small muted">{t("prices.slots.hint")}</span>
        </label>
        <Money
          label={t("prices.damageFee")}
          cents={current.damageFeeCents}
          onChange={(c) => set({ damageFeeCents: c })}
        />
      </div>
      {/* Minimum spend (Money rules 6; M4-27): per room size, nights and band; off at West 4. */}
      <h3>{t("prices.minSpend.title")}</h3>
      {current.minSpend.length === 0 && <p className="small muted">{t("prices.minSpend")}</p>}
      {current.minSpend.map((row, i) => {
        const setRow = (next: (typeof current.minSpend)[number]) =>
          set({ minSpend: current.minSpend.map((r, j) => (j === i ? next : r)) });
        return (
          <fieldset key={i} className="band">
            <legend>{t("prices.minSpend.row", { n: i + 1 })}</legend>
            <label>
              <span>{t("prices.minSpend.tier")}</span>
              <input
                aria-label={t("prices.minSpend.tier")}
                value={row.tier}
                onChange={(e) => setRow({ ...row, tier: e.target.value })}
              />
            </label>
            <div className="actions">
              {DAYS.map((d) => (
                <label key={d} className="check">
                  <input
                    type="checkbox"
                    checked={row.days.includes(d)}
                    onChange={(e) =>
                      setRow({
                        ...row,
                        days: e.target.checked
                          ? [...row.days, d].sort((a, b) => a - b)
                          : row.days.filter((x) => x !== d),
                      })
                    }
                  />
                  {t(`day.${d}` as never)}
                </label>
              ))}
            </div>
            <label>
              <span>{t("prices.minSpend.band")}</span>
              <select
                aria-label={t("prices.minSpend.band")}
                value={row.band ?? ""}
                onChange={(e) => setRow({ ...row, band: e.target.value || null })}
              >
                <option value="">{t("prices.minSpend.allNight")}</option>
                {current.bands.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <Money
              label={t("prices.minSpend.amount")}
              cents={row.cents}
              onChange={(c) => setRow({ ...row, cents: c })}
            />
            <button
              type="button"
              className="secondary"
              onClick={() => set({ minSpend: current.minSpend.filter((_, j) => j !== i) })}
            >
              {t("prices.minSpend.remove")}
            </button>
          </fieldset>
        );
      })}
      <button
        type="button"
        className="secondary"
        onClick={() =>
          set({ minSpend: [...current.minSpend, { tier: "", days: [5, 6], band: null, cents: 0 }] })
        }
      >
        {t("prices.minSpend.add")}
      </button>
    </div>
  );
}
