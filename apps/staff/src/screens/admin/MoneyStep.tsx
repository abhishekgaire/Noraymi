import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { CashSettings, PaySettings } from "@west4/shared";
import { AdminDraftProvider, useAdminDraft } from "../../admin/draft.js";
import { api, type ApiCallError } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";
import { CardFee, FoodIncludesFee } from "./CardFee.js";
import { CashDrawers } from "./CashDrawers.js";
import { dollarsToCents } from "./Prices.js";

/**
 * Set up your venue's step 7, Money at the counter (O-09; spec 17 · Step
 * details 7): the cash discount (0 to 10%, empty is off, D105), whether food
 * prices include the card fee (with the Kitchen module), the gratuity, then
 * the cash drawers. Once a key is saved, Admin's own form shows here (Card fee
 * & gratuity, Cash drawers). The first time, the `pay` and `drawer` keys are
 * saved whole, so the step also asks the rest of each (the tip screen, tip
 * review, the tip pool, Pay my share, a room hold; the drawer's counts), every
 * answer empty until chosen: nothing is filled in. A drawer change starts at
 * the next business date, as in Admin.
 */
type Register = (save: (() => Promise<boolean>) | null) => void;
type FormState = "empty" | "whole" | "partial";

const notFound = (e: unknown) => {
  if ((e as ApiCallError)?.status === 404) return null;
  throw e;
};

export function MoneyStep({
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
      <MoneyStepBody venueId={venueId} registerSave={registerSave} onSaved={onSaved} />
    </AdminDraftProvider>
  );
}

function MoneyStepBody({
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
  const [loaded, setLoaded] = useState<{ pay: boolean; drawer: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const payForm = useRef<FormState>("empty");
  const drawerForm = useRef<FormState>("empty");
  const saved = useRef(onSaved);
  saved.current = onSaved;

  const load = useCallback(async () => {
    try {
      const has = (key: string) =>
        api("GET", `/v1/venues/${venueId}/settings/${key}`).then(
          () => true,
          (e) => notFound(e) ?? false,
        );
      const [pay, drawer] = await Promise.all([has("pay"), has("drawer")]);
      setLoaded({ pay, drawer });
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
      if (payForm.current === "partial" || drawerForm.current === "partial") {
        setFormError(t("onboarding.money.finish"));
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
      {loaded.pay ? <CardFee /> : <FirstPay report={(s) => (payForm.current = s)} />}
      {loaded.drawer ? <CashDrawers /> : <FirstDrawer report={(s) => (drawerForm.current = s)} />}
      {(formError ?? draft.error) && (
        <p className="error" role="alert">
          {formError ?? (draft.error === "admin_read_only" ? t("plan.refused") : draft.error)}
        </p>
      )}
    </div>
  );
}

const num = (text: string, min = 0, max = Infinity): number | null => {
  if (text.trim() === "") return null;
  const n = Number(text);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};
const whole = (text: string, min = 0): number | null => {
  const n = num(text, min);
  return n !== null && Number.isInteger(n) ? n : null;
};

function Field({
  label,
  value,
  set,
  decimal = false,
}: {
  label: string;
  value: string;
  set: (v: string) => void;
  decimal?: boolean;
}) {
  const { t } = useT();
  return (
    <label>
      <span>{label}</span>
      <input
        inputMode={decimal ? "decimal" : "numeric"}
        aria-label={label}
        value={value}
        placeholder={t("onboarding.notSet")}
        onChange={(e) => set(e.target.value)}
      />
    </label>
  );
}

function Choose<V extends string>({
  label,
  value,
  set,
  options,
}: {
  label: string;
  value: V | "";
  set: (v: V | "") => void;
  options: readonly { value: V; label: string }[];
}) {
  const { t } = useT();
  return (
    <label>
      <span>{label}</span>
      <select aria-label={label} value={value} onChange={(e) => set(e.target.value as V | "")}>
        <option value="">{t("onboarding.choose")}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Group({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset>
      <legend>{legend}</legend>
      <div className="invite-fields">{children}</div>
    </fieldset>
  );
}

/** Report the form's state and put it in the draft once whole. */
function useReport<T>(
  key: string,
  value: T | null,
  touched: boolean,
  report: (s: FormState) => void,
) {
  const draft = useAdminDraft();
  const json = JSON.stringify(value);
  const setRef = useRef(draft.set);
  setRef.current = draft.set;
  useEffect(() => {
    report(!touched ? "empty" : value ? "whole" : "partial");
    if (value) setRef.current(key, JSON.parse(json) as T);
  }, [json, touched]);
}

type YesNo = "yes" | "no";

/** The first `pay` key: every answer empty until chosen. */
function FirstPay({ report }: { report: (s: FormState) => void }) {
  const { t } = useT();
  const { state } = useSession();
  const kitchen =
    state.status === "signedIn" && (state.membership.modules_allowed ?? []).includes("kitchen");
  const [rate, setRate] = useState("");
  const [food, setFood] = useState<boolean | null>(null);
  const [auto, setAuto] = useState<PaySettings["gratuity"]["auto"] | "">("");
  const [gratuityPct, setGratuityPct] = useState("");
  const [partyMin, setPartyMin] = useState("");
  const [tipScreen, setTipScreen] = useState<YesNo | "">("");
  const [pcts, setPcts] = useState(["", "", ""]);
  const [fixed, setFixed] = useState(["", "", ""]);
  const [threshold, setThreshold] = useState("");
  const [overPct, setOverPct] = useState("");
  const [overAmount, setOverAmount] = useState("");
  const [lateHours, setLateHours] = useState("");
  const [pool, setPool] = useState<PaySettings["pool"] | "">("");
  const [payShare, setPayShare] = useState<YesNo | "">("");
  const [roomHold, setRoomHold] = useState<YesNo | "">("");
  const [holdAmount, setHoldAmount] = useState("");

  const touched =
    rate !== "" ||
    food !== null ||
    auto !== "" ||
    tipScreen !== "" ||
    overPct !== "" ||
    overAmount !== "" ||
    lateHours !== "" ||
    pool !== "" ||
    payShare !== "" ||
    roomHold !== "";

  const value: PaySettings | null = (() => {
    // The cash discount (D105): empty is off; 0 to 10%.
    let cardFee: PaySettings["cardFee"] = { mode: "off" };
    if (rate.trim() !== "") {
      const pct = num(rate, 0, 10);
      if (pct === null) return null;
      if (kitchen && food === null) return null;
      cardFee = { mode: "discount", pct, ...(kitchen ? { foodIncludesFee: food! } : {}) };
    }
    if (auto === "") return null;
    let gratuity: PaySettings["gratuity"] = { auto: "off", pct: 0 };
    if (auto !== "off") {
      const pct = num(gratuityPct, 0, 100);
      if (pct === null || pct === 0) return null;
      gratuity = { auto, pct };
      if (auto === "parties") {
        const min = whole(partyMin, 1);
        if (min === null) return null;
        gratuity = { auto, pct, partyMin: min };
      }
    }
    if (tipScreen === "") return null;
    let screen: PaySettings["tipScreen"] = {
      on: false,
      pcts: [0, 0, 0],
      fixedCents: [0, 0, 0],
      smartThresholdCents: 0,
    };
    if (tipScreen === "yes") {
      const p = pcts.map((x) => num(x, 0, 100));
      const f = fixed.map((x) => dollarsToCents(x));
      const th = dollarsToCents(threshold);
      if (p.some((x) => x === null) || f.some((x) => x === null) || th === null) return null;
      screen = {
        on: true,
        pcts: p as [number, number, number],
        fixedCents: f as [number, number, number],
        smartThresholdCents: th,
      };
    }
    const review = { op: num(overPct, 0), oc: dollarsToCents(overAmount), lh: num(lateHours, 0) };
    if (review.op === null || review.oc === null || review.lh === null) return null;
    if (pool === "" || payShare === "" || roomHold === "") return null;
    let hold: PaySettings["roomHold"] = { on: false, cents: 0 };
    if (roomHold === "yes") {
      const c = dollarsToCents(holdAmount);
      if (c === null || c === 0) return null;
      hold = { on: true, cents: c };
    }
    return {
      cardFee,
      gratuity,
      tipScreen: screen,
      tipReview: { overPct: review.op, overCents: review.oc, lateHours: review.lh },
      pool,
      roomHold: hold,
      payShare: { on: payShare === "yes" },
    } as PaySettings;
  })();
  useReport("pay", value, touched, report);

  const yesNo = [
    { value: "yes" as const, label: t("onboarding.yes") },
    { value: "no" as const, label: t("onboarding.no") },
  ];
  return (
    <div className="card-fee-admin">
      <h3>{t("admin.section.cardFee")}</h3>
      <p className="muted small">{t("onboarding.money.hint")}</p>
      <Group legend={t("cardFeeAdmin.fee")}>
        <Field label={t("onboarding.money.discountRate")} value={rate} set={setRate} decimal />
        <p className="small muted">{t("cardFeeAdmin.discount.hint")}</p>
        {kitchen && rate.trim() !== "" && <FoodIncludesFee value={food} onChange={setFood} />}
      </Group>
      <Group legend={t("cardFeeAdmin.gratuity")}>
        <Choose
          label={t("cardFeeAdmin.gratuity.auto")}
          value={auto}
          set={setAuto}
          options={(["off", "rooms", "parties", "all"] as const).map((a) => ({
            value: a,
            label: t(`cardFeeAdmin.gratuity.${a}`),
          }))}
        />
        {auto !== "" && auto !== "off" && (
          <Field
            label={t("cardFeeAdmin.gratuity.pct")}
            value={gratuityPct}
            set={setGratuityPct}
            decimal
          />
        )}
        {auto === "parties" && (
          <Field label={t("cardFeeAdmin.gratuity.partyMin")} value={partyMin} set={setPartyMin} />
        )}
      </Group>
      <Group legend={t("cardFeeAdmin.tips")}>
        <Choose
          label={t("cardFeeAdmin.tips.on")}
          value={tipScreen}
          set={setTipScreen}
          options={yesNo}
        />
        {tipScreen === "yes" &&
          [0, 1, 2].map((i) => (
            <Field
              key={`p${i}`}
              label={t("cardFeeAdmin.tips.pct", { n: i + 1 })}
              value={pcts[i]!}
              set={(v) => setPcts(pcts.map((x, j) => (j === i ? v : x)))}
              decimal
            />
          ))}
        {tipScreen === "yes" && (
          <Field
            label={t("onboarding.money.threshold")}
            value={threshold}
            set={setThreshold}
            decimal
          />
        )}
        {tipScreen === "yes" &&
          [0, 1, 2].map((i) => (
            <Field
              key={`f${i}`}
              label={t("onboarding.money.fixed", { n: i + 1 })}
              value={fixed[i]!}
              set={(v) => setFixed(fixed.map((x, j) => (j === i ? v : x)))}
              decimal
            />
          ))}
      </Group>
      <Group legend={t("cardFeeAdmin.review")}>
        <Field label={t("onboarding.money.overPct")} value={overPct} set={setOverPct} decimal />
        <Field
          label={t("onboarding.money.overAmount")}
          value={overAmount}
          set={setOverAmount}
          decimal
        />
        <Field
          label={t("onboarding.money.lateHours")}
          value={lateHours}
          set={setLateHours}
          decimal
        />
      </Group>
      <Group legend={t("pool.title")}>
        <Choose
          label={t("pool.method")}
          value={pool}
          set={setPool}
          options={(["hours", "even", "roomServer"] as const).map((m) => ({
            value: m,
            label: t(`pool.method.${m}`),
          }))}
        />
        <Choose
          label={t("cardFeeAdmin.payShare")}
          value={payShare}
          set={setPayShare}
          options={yesNo}
        />
        <Choose
          label={t("onboarding.money.roomHold")}
          value={roomHold}
          set={setRoomHold}
          options={yesNo}
        />
        {roomHold === "yes" && (
          <Field
            label={t("onboarding.money.roomHoldAmount")}
            value={holdAmount}
            set={setHoldAmount}
            decimal
          />
        )}
      </Group>
    </div>
  );
}

/** The first `drawer` key: every answer empty until chosen. */
function FirstDrawer({ report }: { report: (s: FormState) => void }) {
  const { t } = useT();
  const [model, setModel] = useState<CashSettings["drawer"] | "">("");
  const [bank, setBank] = useState("");
  const [noteOver, setNoteOver] = useState("");
  const [second, setSecond] = useState<CashSettings["secondCounter"] | "">("");
  const [paidOut, setPaidOut] = useState("");
  const [who, setWho] = useState<CashSettings["perPerson"]["who"] | "">("");
  const [countLater, setCountLater] = useState<YesNo | "">("");

  const touched = model !== "" || bank !== "" || noteOver !== "" || second !== "" || paidOut !== "";
  const value: CashSettings | null = (() => {
    const b = dollarsToCents(bank);
    const n = dollarsToCents(noteOver);
    const p = dollarsToCents(paidOut);
    if (model === "" || b === null || n === null || p === null || second === "") return null;
    if (model === "perPerson" && (who === "" || countLater === "")) return null;
    return {
      drawer: model,
      startingBankCents: b,
      noteOverCents: n,
      secondCounter: second,
      paidOutApprovalCents: p,
      // With the house drawer the per-person answers are unused; they're saved as the form shows them.
      perPerson: {
        who: who === "" ? "bartenders" : who,
        countLater: countLater === "yes",
      },
    };
  })();
  useReport("drawer", value, touched, report);

  return (
    <div className="cash-admin">
      <h3>{t("admin.section.cashDrawers")}</h3>
      <div className="invite-fields">
        <Choose
          label={t("cashAdmin.model")}
          value={model}
          set={setModel}
          options={(["house", "perPerson"] as const).map((m) => ({
            value: m,
            label: t(m === "house" ? "cashAdmin.house" : "cashAdmin.perPerson"),
          }))}
        />
        {model === "perPerson" && (
          <Choose
            label={t("cashAdmin.perPersonWho")}
            value={who}
            set={setWho}
            options={(["bartenders", "bartendersAndServers"] as const).map((w) => ({
              value: w,
              label: t(`cashAdmin.who.${w}`),
            }))}
          />
        )}
        {model === "perPerson" && (
          <Choose
            label={t("cashAdmin.countLater")}
            value={countLater}
            set={setCountLater}
            options={[
              { value: "yes" as const, label: t("onboarding.yes") },
              { value: "no" as const, label: t("onboarding.no") },
            ]}
          />
        )}
        <Field label={t("cashAdmin.startingBank")} value={bank} set={setBank} decimal />
        <Field label={t("cashAdmin.noteOver")} value={noteOver} set={setNoteOver} decimal />
        <Choose
          label={t("cashAdmin.secondCounter")}
          value={second}
          set={setSecond}
          options={(["never", "whenOff", "always"] as const).map((s) => ({
            value: s,
            label: t(`cashAdmin.second.${s}`),
          }))}
        />
        <Field label={t("cashAdmin.paidOut")} value={paidOut} set={setPaidOut} decimal />
      </div>
    </div>
  );
}
