import { useCallback, useEffect, useRef, useState } from "react";
import type { MessageKey, PriceSettings } from "@west4/shared";
import { AdminDraftProvider, useAdminDraft } from "../../admin/draft.js";
import { api, type ApiCallError } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";
import { Prices, dollarsToCents } from "./Prices.js";
import { AddRoom } from "./Rooms.js";

/**
 * Set up your venue's step 4, Rooms and prices (O-06; spec 17 · Step details 4).
 * The rooms are Admin → Rooms' own (POST /rooms, PATCH /rooms/{r}); the prices
 * are the `prices` key through Save, as in Admin → Prices. A venue with prices
 * saved edits them in Admin's own form here. The first time, every amount,
 * capacity and time starts empty and is typed by the owner: nothing is
 * filled in. The prices key also holds the booking limits and the damage fee,
 * so the first save asks for them too (each empty until typed).
 */
interface Room {
  readonly id: string;
  readonly name: string;
  readonly size_tier: string;
  readonly capacity_min: number;
  readonly capacity_max: number;
  readonly is_vip: boolean;
  readonly bookable_online: boolean;
}

type Register = (save: (() => Promise<boolean>) | null) => void;
const TIERS = ["small", "medium", "large", "vip"];
const DAYS = [1, 2, 3, 4, 5, 6, 0] as const;
type Mode = PriceSettings["rate"]["mode"];
type Rate = PriceSettings["rate"];

export function RoomsStep({
  registerSave,
  onSaved,
}: {
  registerSave: Register;
  onSaved: () => void;
}) {
  const { state } = useSession();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : "";
  if (!venueId) return null;
  return (
    <AdminDraftProvider venueId={venueId}>
      <RoomsStepBody venueId={venueId} registerSave={registerSave} onSaved={onSaved} />
    </AdminDraftProvider>
  );
}

function RoomsStepBody({
  venueId,
  registerSave,
  onSaved,
}: {
  venueId: string;
  registerSave: Register;
  onSaved: () => void;
}) {
  const { t } = useT();
  const draft = useAdminDraft();
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [pricesSaved, setPricesSaved] = useState<boolean | null>(null);
  const [roomsModule, setRoomsModule] = useState<"on" | "off" | "not_allowed">("on");
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const saved = useRef(onSaved);
  saved.current = onSaved;
  // The first-time price form reports whether what's typed is whole (or untouched).
  const pricesForm = useRef<"empty" | "whole" | "partial">("empty");

  const load = useCallback(async () => {
    try {
      const modules = await api<{ modules: { id: string; allowed: boolean; state: string }[] }>(
        "GET",
        `/v1/venues/${venueId}/modules`,
      );
      const rooms = modules.modules.find((m) => m.id === "rooms");
      const on = rooms?.state === "on";
      setRoomsModule(on ? "on" : rooms?.allowed ? "off" : "not_allowed");
      const [list, prices] = await Promise.all([
        // Admin → Rooms answers only while Rooms & room clock is on.
        on
          ? api<{ rooms: Room[] }>("GET", `/v1/venues/${venueId}/rooms`)
          : Promise.resolve({ rooms: [] as Room[] }),
        api("GET", `/v1/venues/${venueId}/settings/prices`).then(
          () => true,
          (e: unknown) => {
            if ((e as ApiCallError)?.status === 404) return false;
            throw e;
          },
        ),
      ]);
      setRooms(list.rooms);
      setPricesSaved(prices);
      setError(null);
    } catch {
      setError(t("shell.error.cantReach"));
    }
  }, [venueId, t]);
  useEffect(() => {
    void load();
  }, [load, draft.version]);

  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    registerSave(async () => {
      if (pricesForm.current === "partial") {
        setFormError(t("onboarding.rooms.finishPrices"));
        return false;
      }
      setFormError(null);
      if (!draftRef.current.dirty) return true;
      const ok = await draftRef.current.save();
      if (ok) saved.current();
      return ok;
    });
    return () => registerSave(null);
  }, [registerSave, t]);

  const toggleOnline = async (room: Room) => {
    try {
      await api("PATCH", `/v1/venues/${venueId}/rooms/${room.id}`, {
        bookable_online: !room.bookable_online,
      });
      await load();
    } catch (e) {
      setError((e as ApiCallError)?.message ?? t("rooms.failed"));
    }
  };

  if (error && rooms === null)
    return (
      <div className="setup-card">
        <div className="error" role="alert">
          <p>{error}</p>
          <button type="button" className="secondary" onClick={() => void load()}>
            {t("shell.error.retry")}
          </button>
        </div>
      </div>
    );
  if (rooms === null || pricesSaved === null)
    return (
      <div className="setup-card">
        <p role="status">{t("shell.loading")}</p>
      </div>
    );

  return (
    <div className="setup-card setup-form">
      <h3>{t("admin.section.rooms")}</h3>
      {roomsModule === "not_allowed" ? (
        <p className="notice" role="status">
          {t("onboarding.rooms.needsPlan")}
        </p>
      ) : roomsModule === "off" ? (
        // The plan switched Rooms & room clock on (D121); the owner turned it off since.
        <p className="notice" role="status">
          {t("onboarding.rooms.moduleOff")}
        </p>
      ) : rooms.length === 0 ? (
        <p className="muted">{t("onboarding.rooms.none")}</p>
      ) : (
        <ul className="setup-rooms">
          {rooms.map((r) => (
            <li key={r.id}>
              <strong>{r.name}</strong>
              <span>
                {TIERS.includes(r.size_tier)
                  ? t(`rooms.tier.${r.size_tier}` as MessageKey)
                  : r.size_tier}
              </span>
              <span>{t("rooms.capacity", { min: r.capacity_min, max: r.capacity_max })}</span>
              <label className="setup-check">
                <input
                  type="checkbox"
                  aria-label={`${r.name} · ${t("rooms.col.online")}`}
                  checked={r.bookable_online}
                  onChange={() => void toggleOnline(r)}
                />
                {r.bookable_online ? t("rooms.bookable") : t("rooms.notBookable")}
              </label>
            </li>
          ))}
        </ul>
      )}
      {roomsModule === "on" && (
        <AddRoom
          venueId={venueId}
          onAdded={async () => {
            await load();
            saved.current();
          }}
        />
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {pricesSaved ? (
        <Prices />
      ) : (
        <FirstPrices rooms={rooms} report={(s) => (pricesForm.current = s)} />
      )}
      {(formError ?? draft.error) && (
        <p className="error" role="alert">
          {formError ?? (draft.error === "admin_read_only" ? t("plan.refused") : draft.error)}
        </p>
      )}
    </div>
  );
}

/** A whole number typed by the owner, or null. */
const whole = (s: string): number | null => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : null);
const positive = (s: string): number | null => {
  const n = whole(s);
  return n !== null && n > 0 ? n : null;
};
const hours = (s: string): number | null =>
  /^\d+(\.\d+)?$/.test(s.trim()) && Number(s) > 0 ? Number(s) : null;
const minutesOf = (v: string) => {
  const [h, m] = v.split(":").map(Number) as [number, number];
  return h * 60 + m;
};

interface RateText {
  perPerson: string;
  base: string;
  baseGuests: string;
  extra: string;
  bySize: Record<string, string>;
}
const emptyRate = (): RateText => ({
  perPerson: "",
  base: "",
  baseGuests: "",
  extra: "",
  bySize: {},
});

function rateOf(mode: Mode | "", r: RateText, tiers: string[]): Rate | null {
  if (mode === "perPerson") {
    const c = dollarsToCents(r.perPerson);
    return c === null ? null : { mode, perPersonCents: c };
  }
  if (mode === "basePlusExtra") {
    const base = dollarsToCents(r.base);
    const extra = dollarsToCents(r.extra);
    const guests = positive(r.baseGuests);
    return base === null || extra === null || guests === null
      ? null
      : { mode, baseCents: base, baseGuests: guests, extraCents: extra };
  }
  if (mode === "flatBySize") {
    const bySizeCents: Record<string, number> = {};
    for (const tier of tiers) {
      const c = dollarsToCents(r.bySize[tier] ?? "");
      if (c === null) return null;
      bySizeCents[tier] = c;
    }
    return tiers.length ? { mode, bySizeCents } : null;
  }
  return null;
}

function RateFields({
  mode,
  value,
  tiers,
  onChange,
  prefix,
}: {
  mode: Mode | "";
  value: RateText;
  tiers: string[];
  onChange: (next: RateText) => void;
  prefix: string;
}) {
  const { t } = useT();
  const field = (label: string, v: string, set: (s: string) => void, money = true) => (
    <label key={label}>
      <span>{label}</span>
      <input
        inputMode={money ? "decimal" : "numeric"}
        aria-label={`${prefix}${label}`}
        value={v}
        placeholder={t("onboarding.notSet")}
        onChange={(e) => set(e.target.value)}
      />
    </label>
  );
  if (mode === "perPerson")
    return field(t("prices.perPerson"), value.perPerson, (s) =>
      onChange({ ...value, perPerson: s }),
    );
  if (mode === "basePlusExtra")
    return (
      <>
        {field(t("prices.base"), value.base, (s) => onChange({ ...value, base: s }))}
        {field(
          t("prices.baseGuests"),
          value.baseGuests,
          (s) => onChange({ ...value, baseGuests: s }),
          false,
        )}
        {field(t("prices.extra"), value.extra, (s) => onChange({ ...value, extra: s }))}
      </>
    );
  if (mode === "flatBySize")
    return (
      <>
        {tiers.map((tier) =>
          field(
            t("prices.flat", { tier: t(`rooms.tier.${tier}` as MessageKey) }),
            value.bySize[tier] ?? "",
            (s) => onChange({ ...value, bySize: { ...value.bySize, [tier]: s } }),
          ),
        )}
      </>
    );
  return null;
}

interface BandText {
  name: string;
  days: number[];
  from: string;
  to: string;
  rate: RateText;
}

/**
 * The first save of the `prices` key: every field empty until the owner types it. While
 * anything is half typed, Continue stays on the step; once it's whole, it goes into the draft.
 */
function FirstPrices({
  rooms,
  report,
}: {
  rooms: readonly Room[];
  report: (state: "empty" | "whole" | "partial") => void;
}) {
  const { t } = useT();
  const draft = useAdminDraft();
  const tiers = [...new Set(rooms.map((r) => r.size_tier))];
  const [mode, setMode] = useState<Mode | "">("");
  const [rate, setRate] = useState<RateText>(emptyRate);
  const [step, setStep] = useState("");
  const [rounding, setRounding] = useState("");
  const [minWeek, setMinWeek] = useState("");
  const [minFriSat, setMinFriSat] = useState("");
  // One minimum for every day of the week (D128: Sing Sing bills at least 3 all week).
  const [minSame, setMinSame] = useState(false);
  const [firstHour, setFirstHour] = useState(false);
  const [bands, setBands] = useState<BandText[]>([]);
  const [vipOn, setVipOn] = useState(false);
  const [vipHourly, setVipHourly] = useState("");
  const [vipFrom, setVipFrom] = useState("");
  const [minHours, setMinHours] = useState("");
  const [maxHours, setMaxHours] = useState("");
  const [maxGuests, setMaxGuests] = useState("");
  const [damage, setDamage] = useState("");

  const touched =
    mode !== "" ||
    step !== "" ||
    rounding !== "" ||
    minWeek !== "" ||
    minFriSat !== "" ||
    bands.length > 0 ||
    vipOn ||
    minHours !== "" ||
    maxHours !== "" ||
    maxGuests !== "" ||
    damage !== "";

  const value: PriceSettings | null = (() => {
    const main = rateOf(mode, rate, tiers);
    const billing =
      step && rounding
        ? {
            incrementMin: Number(step) as 1 | 15 | 30 | 60,
            rounding: rounding as "up" | "nearest" | "down",
          }
        : null;
    const week = positive(minWeek);
    const friSat = minSame ? week : positive(minFriSat);
    const min = hours(minHours);
    const max = hours(maxHours);
    const most = positive(maxGuests);
    const fee = dollarsToCents(damage);
    if (!main || !billing || !week || !friSat || !min || !max || !most || fee === null) return null;
    const madeBands: PriceSettings["bands"] = [];
    for (const b of bands) {
      const r = rateOf(mode, b.rate, tiers);
      if (!b.name.trim() || b.days.length === 0 || !b.from || !b.to || !r) return null;
      const from = minutesOf(b.from);
      const to = minutesOf(b.to);
      madeBands.push({
        name: b.name.trim(),
        days: b.days,
        fromMin: from,
        toMin: to <= from ? to + 1440 : to,
        rate: r,
        billing,
      });
    }
    let vip: PriceSettings["vip"] = null;
    if (vipOn) {
      const hourly = dollarsToCents(vipHourly);
      const from = positive(vipFrom);
      if (hourly === null || from === null) return null;
      vip = {
        roomIds: rooms.filter((r) => r.is_vip).map((r) => r.id),
        hourlyCents: hourly,
        fromGuests: from,
      };
    }
    return {
      rate: main,
      billing,
      minGuests: { weeknight: week, friSat },
      firstHourMinimum: firstHour,
      bands: madeBands,
      vip,
      minSpend: [],
      booking: { minHours: min, maxHours: max, maxGuests: most, startSlots: [] },
      damageFeeCents: fee,
    };
  })();

  // What's typed goes into the draft once whole; half typed, Continue waits.
  const json = JSON.stringify(value);
  const draftSet = useRef(draft.set);
  draftSet.current = draft.set;
  useEffect(() => {
    report(!touched ? "empty" : value ? "whole" : "partial");
    if (value) draftSet.current("prices", JSON.parse(json) as PriceSettings);
  }, [json, touched]);

  const num = (
    label: string,
    v: string,
    set: (s: string) => void,
    mode2: "numeric" | "decimal" = "numeric",
  ) => (
    <label>
      <span>{label}</span>
      <input
        inputMode={mode2}
        aria-label={label}
        value={v}
        placeholder={t("onboarding.notSet")}
        onChange={(e) => set(e.target.value)}
      />
    </label>
  );

  return (
    <div className="setup-prices">
      <h3>{t("prices.title")}</h3>
      <p className="muted small">{t("onboarding.rooms.pricesHint")}</p>
      <div className="invite-fields">
        <label>
          <span>{t("prices.mode")}</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as Mode | "")}>
            <option value="">{t("onboarding.choose")}</option>
            <option value="perPerson">{t("prices.mode.perPerson")}</option>
            <option value="basePlusExtra">{t("prices.mode.basePlusExtra")}</option>
            <option value="flatBySize" disabled={tiers.length === 0}>
              {t("prices.mode.flatBySize")}
            </option>
          </select>
        </label>
        <RateFields mode={mode} value={rate} tiers={tiers} onChange={setRate} prefix="" />
        <label>
          <span>{t("prices.step")}</span>
          <select value={step} onChange={(e) => setStep(e.target.value)}>
            <option value="">{t("onboarding.choose")}</option>
            {[1, 15, 30, 60].map((m) => (
              <option key={m} value={m}>
                {m === 1 ? t("prices.step.minute") : t("prices.step.minutes", { min: m })}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t("prices.rounding")}</span>
          <select value={rounding} onChange={(e) => setRounding(e.target.value)}>
            <option value="">{t("onboarding.choose")}</option>
            {(["up", "nearest", "down"] as const).map((r) => (
              <option key={r} value={r}>
                {t(`prices.rounding.${r}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        {minSame ? (
          num(t("prices.minEveryDay"), minWeek, setMinWeek)
        ) : (
          <>
            {num(t("prices.minWeeknight"), minWeek, setMinWeek)}
            {num(t("prices.minFriSat"), minFriSat, setMinFriSat)}
          </>
        )}
      </div>
      <label className="setup-check">
        <input type="checkbox" checked={minSame} onChange={(e) => setMinSame(e.target.checked)} />
        {t("prices.minSameEveryDay")}
      </label>
      <label className="setup-check">
        <input
          type="checkbox"
          checked={firstHour}
          onChange={(e) => setFirstHour(e.target.checked)}
        />
        {t("prices.firstHour")}
      </label>

      <h4>{t("prices.bands")}</h4>
      {bands.length === 0 && <p className="muted small">{t("prices.bands.none")}</p>}
      {bands.map((b, i) => {
        const setBand = (next: BandText) => setBands(bands.map((x, j) => (j === i ? next : x)));
        const label = t("prices.band.default", { n: i + 1 });
        return (
          <fieldset key={i} className="setup-band">
            <legend>{label}</legend>
            <div className="invite-fields">
              <label>
                <span>{t("prices.band.name")}</span>
                <input
                  aria-label={`${label} · ${t("prices.band.name")}`}
                  value={b.name}
                  onChange={(e) => setBand({ ...b, name: e.target.value })}
                />
              </label>
              <label>
                <span>{t("prices.band.from")}</span>
                <input
                  type="time"
                  aria-label={`${label} · ${t("prices.band.from")}`}
                  value={b.from}
                  onChange={(e) => setBand({ ...b, from: e.target.value })}
                />
              </label>
              <label>
                <span>{t("prices.band.to")}</span>
                <input
                  type="time"
                  aria-label={`${label} · ${t("prices.band.to")}`}
                  value={b.to}
                  onChange={(e) => setBand({ ...b, to: e.target.value })}
                />
              </label>
              <RateFields
                mode={mode}
                value={b.rate}
                tiers={tiers}
                prefix={`${label} · `}
                onChange={(rate) => setBand({ ...b, rate })}
              />
            </div>
            <div className="setup-days">
              {DAYS.map((d) => (
                <label key={d} className="setup-check">
                  <input
                    type="checkbox"
                    aria-label={`${label} · ${t(`day.${d}` as MessageKey)}`}
                    checked={b.days.includes(d)}
                    onChange={(e) =>
                      setBand({
                        ...b,
                        days: e.target.checked ? [...b.days, d] : b.days.filter((x) => x !== d),
                      })
                    }
                  />
                  {t(`day.${d}` as MessageKey)}
                </label>
              ))}
            </div>
            <button
              type="button"
              className="secondary"
              onClick={() => setBands(bands.filter((_, j) => j !== i))}
            >
              {t("prices.band.remove")}
            </button>
          </fieldset>
        );
      })}
      <button
        type="button"
        className="secondary"
        disabled={mode === ""}
        onClick={() =>
          setBands([...bands, { name: "", days: [], from: "", to: "", rate: emptyRate() }])
        }
      >
        {t("prices.band.add")}
      </button>

      <h4>{t("prices.vip")}</h4>
      <label className="setup-check">
        <input type="checkbox" checked={vipOn} onChange={(e) => setVipOn(e.target.checked)} />
        {t("prices.vip.on")}
      </label>
      {vipOn && (
        <div className="invite-fields">
          {num(t("prices.vip.hourly"), vipHourly, setVipHourly, "decimal")}
          {num(t("prices.vip.from"), vipFrom, setVipFrom)}
        </div>
      )}

      <h4>{t("prices.limits")}</h4>
      <div className="invite-fields">
        {num(t("prices.minHours"), minHours, setMinHours, "decimal")}
        {num(t("prices.maxHours"), maxHours, setMaxHours, "decimal")}
        {num(t("prices.maxGuests"), maxGuests, setMaxGuests)}
        {num(t("prices.damageFee"), damage, setDamage, "decimal")}
      </div>
      {touched && !value && (
        <p className="notice small" role="status">
          {t("onboarding.rooms.finishPrices")}
        </p>
      )}
    </div>
  );
}
