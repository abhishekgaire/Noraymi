import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { cents, type MessageKey } from "@west4/shared";
import { api, ApiCallError } from "../../api.js";
import { useConnection } from "../../connection.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";
import { Features } from "./Features.js";

/**
 * Set up your venue's step 2, Your plan (O-04; spec 17 · Step details 2;
 * D114). What you run, then the three plans with their prices read from
 * Stripe (a missing one reads "Not available yet"), a promo code checked
 * against our Promotion Codes, and Start plan, which opens Stripe's own
 * Checkout page: the card never reaches us. Back from Stripe, the step reads
 * "Waiting for Stripe…" until checkout.session.completed has started the plan.
 */
type PlanId = "bar" | "rooms" | "rooms_kitchen";
interface Price {
  readonly amount_cents: number | null;
  readonly currency: string;
  readonly interval: string | null;
}
interface PlanOffer {
  readonly plans: readonly {
    readonly id: PlanId;
    readonly available: boolean;
    readonly base: Price | null;
    readonly room: Price | null;
  }[];
  readonly rooms_now: number;
  readonly current: { readonly plan: PlanId; readonly status: string } | null;
  readonly checkout_open: boolean;
}
interface Promo {
  readonly valid: boolean;
  readonly percent_off?: number | null;
  readonly amount_off_cents?: number | null;
  readonly duration?: "once" | "repeating" | "forever";
  readonly duration_in_months?: number | null;
}

const NAME: Record<PlanId, MessageKey> = {
  bar: "plan.name.bar",
  rooms: "plan.name.rooms",
  rooms_kitchen: "plan.name.rooms_kitchen",
};
const ALLOWS: Record<PlanId, MessageKey> = {
  bar: "onboarding.plan.allows.bar",
  rooms: "onboarding.plan.allows.rooms",
  rooms_kitchen: "onboarding.plan.allows.rooms_kitchen",
};

/** The plan "What you run" points to. */
export function recommendedPlan(run: { rooms: boolean; kitchen: boolean }): PlanId {
  if (run.rooms && run.kitchen) return "rooms_kitchen";
  return run.rooms ? "rooms" : "bar";
}

export function PlanStep({ onSaved }: { onSaved: () => void }) {
  const { t, money } = useT();
  const { state } = useSession();
  const connection = useConnection();
  const [params] = useSearchParams();
  const back = params.get("checkout") === "done";
  const venueId = state.status === "signedIn" ? state.membership.venue_id : null;
  const [offer, setOffer] = useState<PlanOffer | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [run, setRun] = useState({ rooms: false, bar: false, kitchen: false });
  const [chosen, setChosen] = useState<PlanId | null>(null);
  const [code, setCode] = useState("");
  const [promo, setPromo] = useState<Promo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const offline = connection.kind === "offline";
  // The wizard's reload, kept in a ref so a new function each render doesn't reload the plans.
  const saved = useRef(onSaved);
  saved.current = onSaved;
  const started = useRef(false);

  const load = useCallback(async () => {
    if (!venueId) return;
    try {
      const next = await api<PlanOffer>("GET", `/v1/venues/${venueId}/plan/prices`);
      setOffer(next);
      setLoadError(false);
      if (next.current && !started.current) {
        started.current = true;
        saved.current();
      }
    } catch {
      setLoadError(true);
    }
  }, [venueId]);
  useEffect(() => {
    void load();
  }, [load]);
  // Back from Stripe: look again until the plan has started.
  const waiting = back && !!offer && !offer.current;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [waiting, load]);

  const recommended = recommendedPlan(run);
  const plan = chosen ?? recommended;
  const pick = offer?.plans.find((p) => p.id === plan) ?? null;
  const promoPending = code.trim() !== "" && !promo?.valid;

  const priceLine = (p: PlanOffer["plans"][number]) => {
    if (!p.available || !p.base || p.base.amount_cents === null)
      return t("onboarding.plan.unavailable");
    const base = money(cents(p.base.amount_cents));
    return p.room && p.room.amount_cents !== null
      ? t("onboarding.plan.priceRooms", { amount: base, room: money(cents(p.room.amount_cents)) })
      : t("onboarding.plan.price", { amount: base });
  };

  const promoLine = (p: Promo) => {
    if (p.percent_off === 100 && p.duration !== "forever" && (p.duration_in_months ?? 1) === 1)
      return t("onboarding.plan.promoFirstMonth");
    if (p.percent_off) {
      if (p.duration === "forever")
        return t("onboarding.plan.promoForever", { percent: p.percent_off });
      if (p.duration === "repeating")
        return t("onboarding.plan.promoMonths", {
          percent: p.percent_off,
          months: p.duration_in_months ?? 1,
        });
      return t("onboarding.plan.promoOnce", { percent: p.percent_off });
    }
    return t("onboarding.plan.promoOther");
  };

  const check = async () => {
    if (!venueId || !code.trim()) return;
    setError(null);
    try {
      setPromo(
        await api<Promo>(
          "GET",
          `/v1/venues/${venueId}/plan/promo?code=${encodeURIComponent(code.trim())}`,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const start = async () => {
    if (!venueId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ url: string | null }>("POST", `/v1/venues/${venueId}/plan/checkout`, {
        plan,
        ...(code.trim() ? { promo_code: code.trim() } : {}),
      });
      if (r.url) window.location.assign(r.url);
      else await load();
    } catch (e) {
      if (e instanceof ApiCallError && e.details["reason"] === "promo_invalid")
        setPromo({ valid: false });
      else if (e instanceof ApiCallError && e.details["reason"] === "plan_unavailable")
        setError(t("onboarding.plan.unavailable"));
      else setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  if (loadError)
    return (
      <div className="setup-card">
        <div className="error" role="alert">
          <p>{t("onboarding.plan.loadFailed")}</p>
          <button type="button" className="secondary" onClick={() => void load()}>
            {t("shell.error.retry")}
          </button>
        </div>
      </div>
    );
  if (!offer)
    return (
      <div className="setup-card">
        <p role="status">{t("shell.loading")}</p>
      </div>
    );
  if (offer.current)
    return (
      <div className="setup-card">
        <p className="ok" role="status">
          {t("onboarding.plan.started", { plan: t(NAME[offer.current.plan]) })}
        </p>
        <p className="muted">{t("onboarding.plan.changeLater")}</p>
        {/* Choose your features (F-05; D124): Admin → Features' own list, saved as it's switched. */}
        <section className="setup-features" aria-labelledby="choose-features">
          <h3 id="choose-features">{t("onboarding.features.title")}</h3>
          <p className="muted small">{t("onboarding.features.hint")}</p>
          <Features embedded />
        </section>
      </div>
    );
  if (waiting)
    return (
      <div className="setup-card">
        <p role="status">{t("onboarding.plan.waiting")}</p>
      </div>
    );

  return (
    <div className="setup-card setup-plan">
      <fieldset>
        <legend>{t("onboarding.plan.whatYouRun")}</legend>
        {(["rooms", "bar", "kitchen"] as const).map((k) => (
          <label key={k} className="setup-check">
            <input
              type="checkbox"
              checked={run[k]}
              onChange={(e) => {
                setRun({ ...run, [k]: e.target.checked });
                setChosen(null);
              }}
            />
            {t(`onboarding.plan.run.${k}` as MessageKey)}
          </label>
        ))}
      </fieldset>
      <div className="setup-plans" role="radiogroup" aria-label={t("onboarding.plan.choose")}>
        {offer.plans.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={plan === p.id}
            className={`setup-plan-card${plan === p.id ? " chosen" : ""}`}
            onClick={() => setChosen(p.id)}
          >
            <strong>{t(NAME[p.id])}</strong>
            {p.id === recommended && (
              <span className="setup-badge">{t("onboarding.plan.recommended")}</span>
            )}
            <span className={p.available ? "" : "muted"}>{priceLine(p)}</span>
            <span className="muted small">{t(ALLOWS[p.id])}</span>
          </button>
        ))}
      </div>
      {/* In every plan, off until the owner turns it on (D126, D129). */}
      <p className="muted small">{t("onboarding.plan.everyPlan")}</p>
      <div className="setup-promo">
        <label>
          {t("onboarding.plan.promo")}
          <input
            value={code}
            maxLength={64}
            autoComplete="off"
            onChange={(e) => {
              setCode(e.target.value);
              setPromo(null);
            }}
          />
        </label>
        <button
          type="button"
          className="secondary"
          disabled={!code.trim() || offline}
          onClick={() => void check()}
        >
          {t("onboarding.plan.check")}
        </button>
        {promo && (
          <p className={promo.valid ? "ok" : "error"} role="status">
            {promo.valid ? promoLine(promo) : t("onboarding.plan.promoInvalid")}
          </p>
        )}
      </div>
      {offline && (
        <p className="notice" role="status">
          {t("onboarding.plan.offline")}
        </p>
      )}
      <p className="muted small">{t("onboarding.plan.stripeNote")}</p>
      <button
        type="button"
        className="primary"
        disabled={!pick?.available || promoPending || busy || offline}
        onClick={() => void start()}
      >
        {busy ? t("onboarding.plan.starting") : t("onboarding.plan.start")}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
