import { useCallback, useEffect, useRef, useState } from "react";
import type { KitchenSettings, MessageKey, SafetySettings } from "@west4/shared";
import { AdminDraftProvider, useAdminDraft } from "../../admin/draft.js";
import { api, type ApiCallError } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";
import { Hours } from "./Hours.js";
import { KitchenTimes } from "./Kitchen.js";

/**
 * Set up your venue's step 5, Hours (O-06; spec 17 · Step details 5). The
 * weekly hours and the house last call (the `hours` key, never later than the
 * rule pack's last sale: the route's reason shows here), the kitchen's
 * opening and last-order times (only with Kitchen & food allowed), and the
 * age policy (`safety.allAgesUntil`, D108), which the owner picks even when
 * it's "21 and over": nothing is chosen for them. Everything saves together
 * through Save, as in Admin; once hours are saved, Admin's own form edits them.
 */
type Register = (save: (() => Promise<boolean>) | null) => void;
const WEEK = [1, 2, 3, 4, 5, 6, 0] as const;
/** The safety key's product setting when the venue has none yet: the board warns at 90% (spec 03). */
const SAFETY_START: SafetySettings = { occupancyLimit: null, warnAtPct: 90 };

const notFound = (e: unknown) => {
  if ((e as ApiCallError)?.status === 404) return null;
  throw e;
};

export function HoursStep({
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
      <HoursStepBody venueId={venueId} registerSave={registerSave} onSaved={onSaved} />
    </AdminDraftProvider>
  );
}

interface Loaded {
  hoursSaved: boolean;
  kitchen: KitchenSettings | null;
  safety: SafetySettings | null;
}

function HoursStepBody({
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
  const weekState = useRef<"empty" | "whole" | "partial">("empty");
  const saved = useRef(onSaved);
  saved.current = onSaved;

  const load = useCallback(async () => {
    try {
      const [hours, kitchen, safety, modules] = await Promise.all([
        api("GET", `/v1/venues/${venueId}/settings/hours`).then(
          () => true,
          (e) => notFound(e) ?? false,
        ),
        api<{ value: KitchenSettings }>("GET", `/v1/venues/${venueId}/settings/kitchen`),
        api<{ value: SafetySettings }>("GET", `/v1/venues/${venueId}/settings/safety`).catch(
          notFound,
        ),
        api<{ modules: { id: string; allowed: boolean }[] }>(
          "GET",
          `/v1/venues/${venueId}/modules`,
        ),
      ]);
      const kitchenAllowed = modules.modules.some((m) => m.id === "kitchen" && m.allowed);
      setLoaded({
        hoursSaved: hours === true,
        kitchen: kitchenAllowed ? kitchen.value : null,
        safety: safety?.value ?? null,
      });
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
      if (weekState.current === "partial") {
        setFormError(t("onboarding.hours.finishDay"));
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

  if (error && !loaded)
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
  if (!loaded)
    return (
      <div className="setup-card">
        <p role="status">{t("shell.loading")}</p>
      </div>
    );

  const kitchen = (draft.values["kitchen"] as KitchenSettings | undefined) ?? loaded.kitchen;
  return (
    <div className="setup-card setup-form">
      {loaded.hoursSaved ? <Hours /> : <FirstHours report={(s) => (weekState.current = s)} />}
      {kitchen && (
        <fieldset className="setup-fieldset">
          <legend>{t("onboarding.hours.kitchen")}</legend>
          <div className="invite-fields">
            <KitchenTimes current={kitchen} onChange={(next) => draft.set("kitchen", next)} />
          </div>
        </fieldset>
      )}
      <AgePolicy saved={loaded.safety} />
      {(formError ?? draft.error) && (
        <p className="error" role="alert">
          {formError ?? (draft.error === "admin_read_only" ? t("plan.refused") : draft.error)}
        </p>
      )}
    </div>
  );
}

/** The weekly hours the first time: each day's opening and closing typed, or left closed. */
function FirstHours({ report }: { report: (s: "empty" | "whole" | "partial") => void }) {
  const { t } = useT();
  const draft = useAdminDraft();
  const [days, setDays] = useState<Record<number, { opens: string; closes: string }>>({});
  const [lastCall, setLastCall] = useState("");
  const rows = WEEK.map((d) => ({ day: d, ...(days[d] ?? { opens: "", closes: "" }) }));
  const half = rows.some((r) => (r.opens === "") !== (r.closes === ""));
  const weekly = rows.filter((r) => r.opens && r.closes);
  const json = JSON.stringify({ weekly, lastCall, half });
  const draftSet = useRef(draft.set);
  draftSet.current = draft.set;
  useEffect(() => {
    const touched = weekly.length > 0 || half || lastCall !== "";
    report(!touched ? "empty" : half || weekly.length === 0 ? "partial" : "whole");
    if (!half && weekly.length > 0)
      draftSet.current("hours", {
        weekly: weekly.map((r) => ({ day: r.day, opens: r.opens, closes: r.closes })),
        lastCall: lastCall || null,
      });
  }, [json]);

  return (
    <fieldset className="setup-fieldset">
      <legend>{t("hours.weekly")}</legend>
      <p className="muted small">{t("onboarding.hours.weekHint")}</p>
      <div className="setup-week">
        {rows.map((r) => {
          const name = t(`day.${r.day}` as MessageKey);
          const set = (field: "opens" | "closes", v: string) =>
            setDays({ ...days, [r.day]: { opens: r.opens, closes: r.closes, [field]: v } });
          return (
            <div key={r.day} className="setup-day">
              <span>{name}</span>
              <input
                type="time"
                aria-label={`${name} · ${t("hours.opens")}`}
                value={r.opens}
                onChange={(e) => set("opens", e.target.value)}
              />
              <input
                type="time"
                aria-label={`${name} · ${t("hours.closes")}`}
                value={r.closes}
                onChange={(e) => set("closes", e.target.value)}
              />
              {!r.opens && !r.closes && (
                <span className="muted small">{t("hours.kind.closed")}</span>
              )}
            </div>
          );
        })}
      </div>
      <p className="muted small">{t("hours.afterMidnight")}</p>
      <label>
        <span>{t("hours.lastCall")}</span>
        <input
          type="time"
          aria-label={t("hours.lastCall")}
          value={lastCall}
          onChange={(e) => setLastCall(e.target.value)}
        />
        <span className="small muted">{t("hours.lastCall.hint")}</span>
      </label>
      {half && (
        <p className="notice small" role="status">
          {t("onboarding.hours.finishDay")}
        </p>
      )}
    </fieldset>
  );
}

/** The age policy (D108): picked by the owner, even "21 and over"; no choice is made for them. */
function AgePolicy({ saved }: { saved: SafetySettings | null }) {
  const { t } = useT();
  const draft = useAdminDraft();
  const base = (draft.values["safety"] as SafetySettings | undefined) ?? saved;
  const [allAges, setAllAges] = useState<boolean | null>(
    saved ? Boolean(saved.allAgesUntil) : null,
  );
  const set = (allAgesUntil: string | null) =>
    draft.set("safety", { ...(base ?? SAFETY_START), allAgesUntil });
  return (
    <fieldset className="setup-fieldset">
      <legend>{t("safety.age")}</legend>
      {!saved && <p className="muted small">{t("onboarding.hours.ageConfirm")}</p>}
      <label className="setup-check">
        <input
          type="radio"
          name="setupAge"
          checked={allAges === false}
          onChange={() => {
            setAllAges(false);
            set(null);
          }}
        />
        {t("safety.age.over21")}
      </label>
      <label className="setup-check">
        <input
          type="radio"
          name="setupAge"
          checked={allAges === true}
          onChange={() => setAllAges(true)}
        />
        {t("safety.age.allAges")}
      </label>
      {allAges && (
        <label>
          <span>{t("safety.age.until")}</span>
          <input
            type="time"
            aria-label={t("safety.age.until")}
            value={base?.allAgesUntil ?? ""}
            onChange={(e) => {
              if (/^\d\d:\d\d$/.test(e.target.value)) set(e.target.value);
            }}
          />
        </label>
      )}
      <span className="small muted">{t("safety.age.hint")}</span>
    </fieldset>
  );
}
