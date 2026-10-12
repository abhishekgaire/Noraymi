import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  SETUP_STEPS,
  isSetupStep,
  type MessageKey,
  type ModuleId,
  type SetupChecklist,
  type SetupPlan,
  type SetupStep,
  type SetupStepState,
} from "@west4/shared";
import { adminSections } from "../../admin/sections.js";
import { api, ApiCallError } from "../../api.js";
import { useConnection } from "../../connection.js";
import { Dialog, useSheetDialog } from "../../layout/Dialog.js";
import { useT } from "../../i18n.js";
import { homeFor } from "../../navigation.js";
import { useSession } from "../../session.js";
import { CardStep } from "./CardStep.js";
import { DepositsStep } from "./DepositsStep.js";
import { HoursStep } from "./HoursStep.js";
import { MoneyStep } from "./MoneyStep.js";
import { RoomsStep } from "./RoomsStep.js";
import { PlanStep } from "./PlanStep.js";
import { VenueForm } from "./Venue.js";
import "./setup.css";

/**
 * Set up your venue (O-02; spec 17 · How it behaves; screens · Setup). The
 * owner's wizard: a rail of the 12 steps with a mark each, "Step N of 12"
 * and "N of 12 done", Back, Continue, Skip for now and Save and finish
 * later. Every mark comes from GET /setup, read from the rows each step
 * saves to, so this screen, Admin → Setup and the Console agree. The step
 * forms arrive with O-03 to O-13; until then each step says what it asks
 * and opens the Admin section where it lives, whose saves count here at once.
 * The last step holds the checklist and Finish setup.
 */
interface SetupAnswer {
  readonly checklist: SetupChecklist;
  readonly plan: SetupPlan | null;
  readonly onboarded: boolean;
  readonly completed_at: string | null;
}

/** Where each step's answers live afterwards ("Lives in", spec 17); null until its Admin section exists. */
const LIVES_IN: Record<SetupStep, string | null> = {
  venue: "venue",
  plan: null,
  card: null,
  rooms: "rooms",
  hours: "hours",
  deposits: "deposits",
  money: "cardFee",
  menu: "menu",
  team: "team",
  licenses: "licenses",
  texts: "phone",
  devices: "devices",
};

/** The guest-facing modules Finish setup offers to turn on (spec 17 · Ready to open). */
const GUEST_MODULES: readonly ModuleId[] = ["online_booking", "guest_texts", "website"];

const titleKey = (s: SetupStep) => `onboarding.step.${s}.title` as MessageKey;
const hintKey = (s: SetupStep) => `onboarding.step.${s}.hint` as MessageKey;

function useSetup(venueId: string | null) {
  const [answer, setAnswer] = useState<SetupAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!venueId) return;
    try {
      setAnswer(await api<SetupAnswer>("GET", `/v1/venues/${venueId}/setup`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [venueId]);
  useEffect(() => {
    void load();
  }, [load]);
  return { answer, setAnswer, error, reload: load };
}

function sectionOf(step: SetupStep) {
  const id = LIVES_IN[step];
  return id ? (adminSections.find((s) => s.id === id) ?? null) : null;
}

/** The line under a step's name in the rail and the checklist. */
function markLine(
  t: ReturnType<typeof useT>["t"],
  s: SetupStepState,
): { text: string; tone: "done" | "attention" | "muted" } {
  switch (s.mark) {
    case "done":
      return { text: t("onboarding.mark.done"), tone: "done" };
    case "attention":
      return { text: t("onboarding.mark.attention"), tone: "attention" };
    case "not_used":
      return { text: t("onboarding.mark.notUsed"), tone: "muted" };
    case "skipped": {
      if (s.required) return { text: t("onboarding.mark.neededBeforeOpen"), tone: "attention" };
      const section = sectionOf(s.id);
      return {
        text: t("onboarding.mark.optionalLater", {
          section: section ? t(section.labelKey) : t(titleKey(s.id)),
        }),
        tone: "muted",
      };
    }
    default:
      return { text: t("onboarding.mark.notStarted"), tone: "muted" };
  }
}

function markSymbol(s: SetupStepState): string {
  if (s.mark === "done") return "✓";
  if (s.mark === "attention") return "!";
  if (s.mark === "skipped" || s.mark === "not_used") return "–";
  return String(s.number);
}

/** The full-screen wizard at /set-up and /set-up/:step. */
export function SetUpVenue() {
  const { t } = useT();
  const { state, refresh } = useSession();
  const navigate = useNavigate();
  const params = useParams();
  const connection = useConnection();
  const signedIn = state.status === "signedIn" ? state : null;
  const venueId = signedIn?.membership.venue_id ?? null;
  const owner = signedIn?.membership.role === "owner";
  const passkey = signedIn?.me.session.assurance === "passkey";
  const { answer, setAnswer, error, reload } = useSetup(passkey ? venueId : null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // The open step's form, when it has one (O-03 onward): Continue and Save and finish later save it first.
  const stepSave = useRef<(() => Promise<boolean>) | null>(null);
  const registerSave = useCallback((save: (() => Promise<boolean>) | null) => {
    stepSave.current = save;
  }, []);
  const saveStep = async () => (stepSave.current ? stepSave.current() : true);

  const current: SetupStep = isSetupStep(params["step"])
    ? params["step"]
    : (answer?.checklist.next ?? "venue");
  const index = SETUP_STEPS.indexOf(current);
  const go = (step: SetupStep) => navigate(`/set-up/${step}`);

  if (!signedIn) return null;
  if (!passkey)
    return (
      <section className="screen setup-screen">
        <p className="notice" role="status">
          {t("admin.needsPasskey")}
        </p>
      </section>
    );
  if (!owner)
    return (
      <section className="screen setup-screen">
        <SetupChecklistView />
      </section>
    );

  const skip = async () => {
    if (!venueId) return;
    setBusy(true);
    setActionError(null);
    try {
      const next = await api<SetupAnswer>("POST", `/v1/venues/${venueId}/setup/skip`, {
        step: current,
      });
      setAnswer(next);
      if (index < SETUP_STEPS.length - 1) go(SETUP_STEPS[index + 1]!);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const steps = answer?.checklist.steps ?? [];
  const here = steps.find((s) => s.id === current);
  const last = index === SETUP_STEPS.length - 1;

  return (
    <section className="screen setup-screen">
      <div className="setup">
        <aside className="setup-rail">
          <div className="setup-rail-head">
            <h1>{t("onboarding.title")}</h1>
            <span className="setup-venue">{signedIn.membership.venue.name}</span>
          </div>
          <nav aria-label={t("onboarding.steps")}>
            <ol>
              {(steps.length > 0
                ? steps
                : SETUP_STEPS.map((id, i): SetupStepState => ({
                    id,
                    number: i + 1,
                    mark: "not_started",
                    required: false,
                    missing: [],
                  }))
              ).map((s) => {
                const line = markLine(t, s);
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      className={`setup-step mark-${s.mark}`}
                      aria-current={s.id === current ? "step" : undefined}
                      onClick={() => go(s.id)}
                    >
                      <span className="setup-dot" aria-hidden="true">
                        {markSymbol(s)}
                      </span>
                      <span className="setup-step-text">
                        <span className="setup-step-name">{t(titleKey(s.id))}</span>
                        <span className={`setup-step-sub tone-${line.tone}`}>
                          {answer ? line.text : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>
          <p className="setup-note small">{t("onboarding.railNote")}</p>
        </aside>
        <div className="setup-main">
          <header className="setup-head">
            <span className="setup-eyebrow">
              {t("onboarding.stepOf", { n: index + 1, total: SETUP_STEPS.length })}
              {here
                ? ` · ${here.required ? t("onboarding.required") : t("onboarding.optional")}`
                : ""}
            </span>
            <h2>{t(titleKey(current))}</h2>
            <p className="muted">{t(hintKey(current))}</p>
          </header>
          {answer && (
            <div className="setup-progress">
              <div
                role="progressbar"
                aria-label={t("onboarding.progress")}
                aria-valuemin={0}
                aria-valuemax={answer.checklist.total}
                aria-valuenow={answer.checklist.done}
                className="setup-bar"
              >
                <div
                  style={{ width: `${(100 * answer.checklist.done) / answer.checklist.total}%` }}
                />
              </div>
              <span className="setup-count">
                {t("onboarding.doneOf", {
                  n: answer.checklist.done,
                  total: answer.checklist.total,
                })}
              </span>
            </div>
          )}
          <div className="setup-body">
            {connection.kind === "offline" && (
              <p className="notice" role="status">
                {t("onboarding.offline")}
              </p>
            )}
            {!answer && !error && <p role="status">{t("shell.loading")}</p>}
            {error && (
              <div className="error" role="alert">
                <p>{t("onboarding.loadFailed")}</p>
                <button type="button" className="secondary" onClick={() => void reload()}>
                  {t("shell.error.retry")}
                </button>
              </div>
            )}
            {answer && here && (
              <StepBody step={here} registerSave={registerSave} onSaved={() => void reload()} />
            )}
            {answer && last && (
              <Readiness answer={answer} onFinish={() => setConfirming(true)} busy={busy} />
            )}
            {actionError && (
              <p className="error" role="alert">
                {actionError}
              </p>
            )}
          </div>
          <footer className="setup-foot">
            <button
              type="button"
              className="secondary"
              onClick={() =>
                void saveStep().then((ok) => {
                  if (ok) navigate(homeFor(signedIn.membership.role));
                })
              }
            >
              {t("onboarding.saveLater")}
            </button>
            <div className="setup-foot-right">
              {index > 0 && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => go(SETUP_STEPS[index - 1]!)}
                >
                  {t("onboarding.back")}
                </button>
              )}
              {here && here.mark !== "done" && here.mark !== "not_used" && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => void skip()}
                >
                  {t("onboarding.skip")}
                </button>
              )}
              {!last && (
                <button
                  type="button"
                  className="primary"
                  onClick={() =>
                    void saveStep().then(async (ok) => {
                      if (!ok) return;
                      await reload();
                      go(SETUP_STEPS[index + 1]!);
                    })
                  }
                >
                  {t("onboarding.continue")}
                </button>
              )}
            </div>
          </footer>
        </div>
      </div>
      {confirming && venueId && (
        <FinishDialog
          venueId={venueId}
          allowed={signedIn.membership.modules_allowed ?? []}
          onCancel={() => setConfirming(false)}
          onDone={async (next) => {
            setConfirming(false);
            setAnswer(next);
            await refresh();
            navigate("/admin/setup");
          }}
        />
      )}
    </section>
  );
}

function StepBody({
  step,
  registerSave,
  onSaved,
}: {
  step: SetupStepState;
  registerSave: (save: (() => Promise<boolean>) | null) => void;
  onSaved: () => void;
}) {
  const { t } = useT();
  const section = sectionOf(step.id);
  // Step 1's form (O-03): the same one as Admin → Venue.
  if (step.id === "venue")
    return (
      <div className="setup-card">
        <VenueForm registerSave={registerSave} onSaved={onSaved} />
      </div>
    );
  // Step 2's plans, promo code and Start plan (O-04).
  if (step.id === "plan") return <PlanStep onSaved={onSaved} />;
  // Step 3's Connect with Stripe (O-05).
  if (step.id === "card") return <CardStep onSaved={onSaved} />;
  // Steps 4 and 5 (O-06): Admin's rooms, prices, hours, kitchen times and age policy.
  if (step.id === "rooms" && step.mark !== "not_used")
    return <RoomsStep registerSave={registerSave} onSaved={onSaved} />;
  if (step.id === "hours") return <HoursStep registerSave={registerSave} onSaved={onSaved} />;
  // Step 6 (O-07): Admin's deposits and the four walk-in choices.
  if (step.id === "deposits" && step.mark !== "not_used")
    return <DepositsStep registerSave={registerSave} onSaved={onSaved} />;
  // Step 7 (O-09): the cash discount, food and the card fee, gratuity and the drawers.
  if (step.id === "money") return <MoneyStep registerSave={registerSave} onSaved={onSaved} />;
  return (
    <div className="setup-card">
      {section ? (
        <>
          <p>{t("onboarding.livesIn", { section: t(section.labelKey) })}</p>
          <Link to={section.path} className="button secondary">
            {t("onboarding.openSection", { section: t(section.labelKey) })}
          </Link>
        </>
      ) : (
        <p className="muted">{t("onboarding.livesInSoon")}</p>
      )}
      {step.missing.length > 0 && step.mark !== "not_used" && (
        <>
          <h3>{t("onboarding.stillNeeded")}</h3>
          <ul>
            {step.missing.map((m) => (
              <li key={m}>{t(`onboarding.missing.${m}` as MessageKey)}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** Ready to open, or what's missing with a link to each step; then Finish setup. */
function Readiness({
  answer,
  onFinish,
  busy,
}: {
  answer: SetupAnswer;
  onFinish: () => void;
  busy: boolean;
}) {
  const { t } = useT();
  const c = answer.checklist;
  return (
    <div className="setup-card setup-ready">
      {answer.completed_at ? (
        <p className="ok" role="status">
          {t("onboarding.finished")}
        </p>
      ) : (
        <>
          <h3>{c.ready ? t("onboarding.ready") : t("onboarding.notReady")}</h3>
          {!c.ready && <MissingList checklist={c} />}
          <p className="muted small">{t("onboarding.finishHint")}</p>
          <button type="button" className="primary" disabled={!c.ready || busy} onClick={onFinish}>
            {t("onboarding.finish")}
          </button>
        </>
      )}
    </div>
  );
}

function MissingList({ checklist, readOnly }: { checklist: SetupChecklist; readOnly?: boolean }) {
  const { t } = useT();
  return (
    <ul className="setup-missing">
      {checklist.steps
        .filter((s) => checklist.blocking.includes(s.id))
        .map((s) => (
          <li key={s.id}>
            <span>
              {t("onboarding.missingLine", {
                n: s.number,
                step: t(titleKey(s.id)),
                what: s.missing.map((m) => t(`onboarding.missing.${m}` as MessageKey)).join(", "),
              })}
            </span>
            {!readOnly && (
              <Link to={`/set-up/${s.id}`} className="button secondary">
                {t("onboarding.go")}
              </Link>
            )}
          </li>
        ))}
    </ul>
  );
}

function FinishTitle() {
  const { t } = useT();
  const { title } = useSheetDialog(t("onboarding.finishConfirm.title"));
  return <h2 {...title}>{t("onboarding.finishConfirm.title")}</h2>;
}

function FinishDialog({
  venueId,
  allowed,
  onCancel,
  onDone,
}: {
  venueId: string;
  allowed: readonly ModuleId[];
  onCancel: () => void;
  onDone: (answer: SetupAnswer) => Promise<void>;
}) {
  const { t } = useT();
  const offered = GUEST_MODULES.filter((m) => allowed.includes(m));
  const [ticked, setTicked] = useState<ModuleId[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      const answer = await api<SetupAnswer>("POST", `/v1/venues/${venueId}/setup/finish`, {});
      // The same switch Admin → Features uses (PATCH /modules/{id}).
      for (const id of ticked)
        await api("PATCH", `/v1/venues/${venueId}/modules/${id}`, { state: "on" });
      await onDone(answer);
    } catch (e) {
      setError(
        e instanceof ApiCallError && e.code === "admin_read_only"
          ? t("plan.refused")
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog onClose={onCancel}>
      <FinishTitle />
      {offered.length > 0 ? (
        <>
          <p>{t("onboarding.finishConfirm.body")}</p>
          {offered.map((id) => (
            <label key={id} className="setup-tick">
              <input
                type="checkbox"
                checked={ticked.includes(id)}
                onChange={(e) =>
                  setTicked((list) =>
                    e.target.checked ? [...list, id] : list.filter((x) => x !== id),
                  )
                }
              />
              <span>{t(`module.${id}.name` as MessageKey)}</span>
            </label>
          ))}
        </>
      ) : (
        <p className="muted">{t("onboarding.finishConfirm.none")}</p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button type="button" className="secondary" onClick={onCancel}>
          {t("onboarding.finishConfirm.cancel")}
        </button>
        <button type="button" className="primary" disabled={busy} onClick={() => void finish()}>
          {busy ? t("onboarding.saving") : t("onboarding.finish")}
        </button>
      </div>
    </Dialog>
  );
}

/** Admin → Setup: the checklist; the owner's links open the wizard, a manager reads it. */
export function SetupChecklistView() {
  const { t } = useT();
  const { state } = useSession();
  const connection = useConnection();
  const signedIn = state.status === "signedIn" ? state : null;
  const owner = signedIn?.membership.role === "owner";
  const { answer, error, reload } = useSetup(signedIn?.membership.venue_id ?? null);
  return (
    <div className="setup-checklist">
      <h2>{t("onboarding.title")}</h2>
      {connection.kind === "offline" && (
        <p className="notice" role="status">
          {t("onboarding.offline")}
        </p>
      )}
      {!answer && !error && <p role="status">{t("shell.loading")}</p>}
      {error && (
        <div className="error" role="alert">
          <p>{t("onboarding.loadFailed")}</p>
          <button type="button" className="secondary" onClick={() => void reload()}>
            {t("shell.error.retry")}
          </button>
        </div>
      )}
      {answer && (
        <>
          <p className="setup-count" role="status">
            {owner || answer.completed_at
              ? t("onboarding.doneOf", { n: answer.checklist.done, total: answer.checklist.total })
              : t("onboarding.managerLine", {
                  done: answer.checklist.done,
                  total: answer.checklist.total,
                })}
          </p>
          {answer.completed_at ? (
            <p className="ok">{t("onboarding.finished")}</p>
          ) : (
            <p>{answer.checklist.ready ? t("onboarding.ready") : t("onboarding.notReady")}</p>
          )}
          {!owner && <p className="muted small">{t("onboarding.readOnly")}</p>}
          <ol className="setup-list">
            {answer.checklist.steps.map((s) => {
              const line = markLine(t, s);
              return (
                <li key={s.id} className={`mark-${s.mark}`}>
                  <span className="setup-dot" aria-hidden="true">
                    {markSymbol(s)}
                  </span>
                  <span className="setup-step-text">
                    <span className="setup-step-name">{t(titleKey(s.id))}</span>
                    <span className={`setup-step-sub tone-${line.tone}`}>{line.text}</span>
                  </span>
                  {owner && (
                    <Link to={`/set-up/${s.id}`} className="button secondary">
                      {t("onboarding.go")}
                    </Link>
                  )}
                </li>
              );
            })}
          </ol>
          {owner && !answer.completed_at && (
            <Link to="/set-up" className="button primary">
              {t("onboarding.openWizard")}
            </Link>
          )}
        </>
      )}
    </div>
  );
}
