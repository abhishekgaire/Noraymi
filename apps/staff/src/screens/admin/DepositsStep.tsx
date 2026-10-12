import { useCallback, useEffect, useRef, useState } from "react";
import { walkInTakes, type DepositRule, type PriceSettings, type WalkInTakes } from "@west4/shared";
import { AdminDraftProvider, useAdminDraft } from "../../admin/draft.js";
import { api, type ApiCallError } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";
import { Deposits } from "./Deposits.js";
import { dollarsToCents } from "./Prices.js";

/**
 * Set up your venue's step 6, Deposits and check-in (O-07; spec 17 · Step
 * details 6). The `deposit` key through Save, as in Admin → Deposits &
 * cancelling: once it's saved, Admin's own form shows here. The first time,
 * every answer starts empty and is chosen by the owner, the walk-in choice
 * included (D112, D116): nothing is preselected or filled in. With no deposit
 * for online bookings, only the grace minutes and the walk-in choice are
 * asked; the rest is saved as "nothing kept, nothing charged". The largest
 * party online (the `prices` key, step 4) shows again below.
 */
type Register = (save: (() => Promise<boolean>) | null) => void;
type FormState = "empty" | "whole" | "partial";
const MODES = ["firstHour", "perPerson", "flat", "percent", "cardHold"] as const;
const LATE = ["keep", "half", "refund"] as const;
const NO_SHOW = ["keep", "firstHour", "nothing"] as const;

const notFound = (e: unknown) => {
  if ((e as ApiCallError)?.status === 404) return null;
  throw e;
};

export function DepositsStep({
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
      <DepositsStepBody venueId={venueId} registerSave={registerSave} onSaved={onSaved} />
    </AdminDraftProvider>
  );
}

interface Loaded {
  depositSaved: boolean;
  prices: PriceSettings | null;
}

function DepositsStepBody({
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
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const form = useRef<FormState>("empty");
  const saved = useRef(onSaved);
  saved.current = onSaved;

  const load = useCallback(async () => {
    try {
      const [deposit, prices] = await Promise.all([
        api("GET", `/v1/venues/${venueId}/settings/deposit`).then(
          () => true,
          (e) => notFound(e) ?? false,
        ),
        api<{ value: PriceSettings }>("GET", `/v1/venues/${venueId}/settings/prices`).catch(
          notFound,
        ),
      ]);
      setLoaded({ depositSaved: deposit, prices: prices?.value ?? null });
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
      if (form.current === "partial") {
        setFormError(t("onboarding.deposits.finish"));
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

  if (error && loaded === null)
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
  if (loaded === null)
    return (
      <div className="setup-card">
        <p role="status">{t("shell.loading")}</p>
      </div>
    );

  return (
    <div className="setup-card setup-form">
      {loaded.depositSaved ? <Deposits /> : <FirstDeposit report={(s) => (form.current = s)} />}
      <LargestParty prices={loaded.prices} />
      {(formError ?? draft.error) && (
        <p className="error" role="alert">
          {formError ?? (draft.error === "admin_read_only" ? t("plan.refused") : draft.error)}
        </p>
      )}
    </div>
  );
}

const whole = (text: string, min = 0): number | null => {
  if (text.trim() === "") return null;
  const n = Number(text);
  return Number.isInteger(n) && n >= min ? n : null;
};

/** The first deposit rule, typed from nothing. */
function FirstDeposit({ report }: { report: (state: FormState) => void }) {
  const { t } = useT();
  const draft = useAdminDraft();
  const [mode, setMode] = useState<DepositRule["mode"] | "off" | "">("");
  const [amount, setAmount] = useState("");
  const [refundHours, setRefundHours] = useState("");
  const [late, setLate] = useState<DepositRule["late"] | "">("");
  const [noShow, setNoShow] = useState<DepositRule["noShow"] | "">("");
  const [grace, setGrace] = useState("");
  const [bigOn, setBigOn] = useState(false);
  const [bigFrom, setBigFrom] = useState("");
  const [bigAmount, setBigAmount] = useState("");
  const [bigRefund, setBigRefund] = useState("");
  const [walkIn, setWalkIn] = useState<WalkInTakes | "">("");

  const touched =
    mode !== "" ||
    amount !== "" ||
    refundHours !== "" ||
    late !== "" ||
    noShow !== "" ||
    grace !== "" ||
    bigOn ||
    walkIn !== "";

  const value: DepositRule | null = (() => {
    const graceMin = whole(grace);
    if (mode === "" || walkIn === "" || graceMin === null) return null;
    // No deposit for online bookings: nothing kept and nothing charged.
    if (mode === "off")
      return {
        on: false,
        mode: "firstHour",
        value: 0,
        refundHours: 0,
        late: "refund",
        noShow: "nothing",
        graceMin,
        bigParty: null,
        walkIn,
      };
    const v =
      mode === "perPerson" || mode === "flat"
        ? dollarsToCents(amount)
        : mode === "percent"
          ? whole(amount, 1)
          : 0;
    const hours = whole(refundHours);
    if (
      v === null ||
      (mode === "percent" && v > 100) ||
      (v === 0 && mode !== "firstHour" && mode !== "cardHold")
    )
      return null;
    if (hours === null || late === "" || noShow === "") return null;
    let bigParty: DepositRule["bigParty"] = null;
    if (bigOn) {
      const from = whole(bigFrom, 2);
      const cents = dollarsToCents(bigAmount);
      const refund = whole(bigRefund);
      if (from === null || cents === null || cents === 0 || refund === null) return null;
      bigParty = { fromGuests: from, deposit: { kind: "flat", cents }, refundHours: refund };
    }
    return {
      on: true,
      mode,
      value: v,
      refundHours: hours,
      late,
      noShow,
      graceMin,
      bigParty,
      walkIn,
    };
  })();

  const json = JSON.stringify(value);
  const draftSet = useRef(draft.set);
  draftSet.current = draft.set;
  useEffect(() => {
    report(!touched ? "empty" : value ? "whole" : "partial");
    if (value) draftSet.current("deposit", JSON.parse(json) as DepositRule);
  }, [json, touched]);

  const num = (label: string, v: string, set: (s: string) => void, decimal = false) => (
    <label>
      <span>{label}</span>
      <input
        inputMode={decimal ? "decimal" : "numeric"}
        aria-label={label}
        value={v}
        placeholder={t("onboarding.notSet")}
        onChange={(e) => set(e.target.value)}
      />
    </label>
  );
  const on = mode !== "" && mode !== "off";

  return (
    <div className="deposits">
      <h3>{t("admin.section.deposits")}</h3>
      <p className="muted small">{t("onboarding.deposits.hint")}</p>
      <div className="invite-fields">
        <label>
          <span>{t("deposits.mode")}</span>
          <select
            aria-label={t("deposits.mode")}
            value={mode}
            onChange={(e) => {
              setMode(e.target.value as DepositRule["mode"] | "off" | "");
              setAmount("");
            }}
          >
            <option value="">{t("onboarding.choose")}</option>
            {MODES.map((m) => (
              <option key={m} value={m}>
                {t(`deposits.mode.${m}`)}
              </option>
            ))}
            <option value="off">{t("onboarding.deposits.none")}</option>
          </select>
        </label>
        {(mode === "perPerson" || mode === "flat") &&
          num(
            t(mode === "flat" ? "deposits.amount" : "deposits.perGuest"),
            amount,
            setAmount,
            true,
          )}
        {mode === "percent" && num(t("deposits.percent"), amount, setAmount)}
        {on && num(t("deposits.refundHours"), refundHours, setRefundHours)}
        {on && (
          <label>
            <span>{t("deposits.late")}</span>
            <select
              aria-label={t("deposits.late")}
              value={late}
              onChange={(e) => setLate(e.target.value as DepositRule["late"] | "")}
            >
              <option value="">{t("onboarding.choose")}</option>
              {LATE.map((m) => (
                <option key={m} value={m}>
                  {t(`deposits.late.${m}`)}
                </option>
              ))}
            </select>
          </label>
        )}
        {on && (
          <label>
            <span>{t("deposits.noShow")}</span>
            <select
              aria-label={t("deposits.noShow")}
              value={noShow}
              onChange={(e) => setNoShow(e.target.value as DepositRule["noShow"] | "")}
            >
              <option value="">{t("onboarding.choose")}</option>
              {NO_SHOW.map((m) => (
                <option key={m} value={m}>
                  {t(`deposits.noShow.${m}`)}
                </option>
              ))}
            </select>
          </label>
        )}
        {num(t("deposits.grace"), grace, setGrace)}
      </div>

      {on && (
        <>
          <h3>{t("deposits.bigParty")}</h3>
          <div className="invite-fields">
            <label className="check">
              <input type="checkbox" checked={bigOn} onChange={(e) => setBigOn(e.target.checked)} />{" "}
              {t("deposits.bigParty.on")}
            </label>
            {bigOn && num(t("deposits.bigParty.from"), bigFrom, setBigFrom)}
            {bigOn && num(t("deposits.bigParty.amount"), bigAmount, setBigAmount, true)}
            {bigOn && num(t("deposits.bigParty.refundHours"), bigRefund, setBigRefund)}
          </div>
        </>
      )}

      <h3>{t("deposits.walkIn")}</h3>
      <p className="small muted">{t("deposits.walkIn.hint")}</p>
      <div className="invite-fields" role="radiogroup" aria-label={t("deposits.walkIn")}>
        {walkInTakes.map((w) => (
          <label key={w} className="check">
            <input
              type="radio"
              name="walk-in-takes"
              checked={walkIn === w}
              onChange={() => setWalkIn(w)}
            />{" "}
            {t(`deposits.walkIn.${w}`)}
          </label>
        ))}
      </div>
    </div>
  );
}

/** The largest party online, from step 4's prices; changed here, it saves with the step. */
function LargestParty({ prices }: { prices: PriceSettings | null }) {
  const { t } = useT();
  const draft = useAdminDraft();
  const current = (draft.values["prices"] as PriceSettings | undefined) ?? prices;
  const [text, setText] = useState(current ? String(current.booking.maxGuests) : "");
  if (!current)
    return (
      <p className="muted small" role="status">
        {t("onboarding.deposits.largestPartyLater")}
      </p>
    );
  return (
    <div className="invite-fields">
      <label>
        <span>{t("prices.maxGuests")}</span>
        <input
          inputMode="numeric"
          aria-label={t("prices.maxGuests")}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const n = whole(e.target.value, 1);
            if (n !== null && n !== current.booking.maxGuests)
              draft.set("prices", { ...current, booking: { ...current.booking, maxGuests: n } });
          }}
        />
      </label>
    </div>
  );
}
