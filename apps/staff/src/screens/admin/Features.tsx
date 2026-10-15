import { useCallback, useEffect, useState } from "react";
import {
  ROOM_ORDERS_NOWHERE_TO_RING,
  type KitchenMissing,
  type MessageKey,
  type ModuleId,
  type ModuleState,
} from "@west4/shared";
import { api, type ApiCallError } from "../../api.js";
import { useEvents } from "../../events.js";
import { useT } from "../../i18n.js";
import { Dialog } from "../../layout/Dialog.js";
import { useSession } from "../../session.js";
import { FeatureChoices } from "./FeatureChoices.js";
import { MenuOrder } from "./MenuOrder.js";

/**
 * Admin → Features (M1-32; spec 03 · Modules, What each module hides;
 * AdminDesk notes 11, 12 and 22). Every phase 1 module within what the
 * Console allows, with its state (on, stopping or off), what it needs and
 * what turning it off hides. Core modules read "Always on"; a module the plan
 * doesn't allow reads "Not in your plan". Kitchen & food before its printer and
 * allergy notice offers "On once ready" (D129): chosen now, on by itself once
 * both are in. Turning one off that others need
 * asks first, and Bar screen & tickets asks "Room orders would have nowhere
 * to ring…" while Ordering from the room is on. Live counts ("5 open bar
 * tabs · 8 rooms in use") arrive with M2 and M6.
 */
interface ModuleRow {
  readonly id: ModuleId;
  readonly allowed: boolean;
  readonly state: ModuleState;
  readonly core: boolean;
  readonly phase1: boolean;
  readonly needs: readonly ModuleId[];
  readonly turns_off_with_it: readonly ModuleId[];
  /** Kitchen & food only (K-01): what it still needs before it can be on. */
  readonly still_needs?: readonly KitchenMissing[];
  /** Chosen "on once ready" (D129): it turns on by itself once what it needs is in. */
  readonly wanted?: boolean;
}

type PatchAnswer =
  | { applied: true }
  | { applied: false; unchanged: true }
  | { applied: false; waiting: true; still_needs: KitchenMissing[] }
  | { applied: false; needs_confirm: true; turns_off: ModuleId[] };

interface Pending {
  readonly id: ModuleId;
  readonly state: ModuleState;
  readonly turnsOff: readonly ModuleId[];
}

const STATES: readonly ModuleState[] = ["on", "stopping", "off"];
const HIDES = ["staffApp", "staffPhone", "website", "texts"] as const;

export function Features({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useT();
  const { state, refresh } = useSession();
  const { subscribe } = useEvents();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : "";
  const [rows, setRows] = useState<ModuleRow[] | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState<ModuleId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const answer = await api<{ modules: ModuleRow[] }>("GET", `/v1/venues/${venueId}/modules`);
    // No phase 1 screen shows the four phase 2 modules (spec 03).
    setRows(answer.modules.filter((m) => m.phase1));
  }, [venueId]);

  useEffect(() => {
    if (!venueId) return;
    load().catch(() => setError(t("shell.error.cantReach")));
  }, [venueId, load, t]);

  // The Console allowing a module (M1-35), or another screen switching one, shows here at once.
  useEffect(
    () =>
      subscribe((events) => {
        if (events.length === 0 || events.some((e) => e.type === "settings.changed"))
          load().catch(() => {});
      }),
    [subscribe, load],
  );

  const change = async (id: ModuleId, next: ModuleState, confirm = false, whenReady = false) => {
    setError(null);
    setBusy(id);
    try {
      const answer = await api<PatchAnswer>(
        "PATCH",
        `/v1/venues/${venueId}/modules/${id}`,
        confirm
          ? { state: next, confirm: true }
          : whenReady
            ? { state: next, when_ready: true }
            : { state: next },
      );
      if (!answer.applied && "needs_confirm" in answer) {
        setPending({ id, state: next, turnsOff: answer.turns_off });
        return;
      }
      setPending(null);
      await load();
      await refresh();
    } catch (e) {
      setError((e as ApiCallError)?.message ?? t("modules.changeFailed"));
    } finally {
      setBusy(null);
    }
  };

  // The room-orders question, followed by the full list when more than Ordering from the room
  // turns off with it (Kitchen & food needs Bar screen & tickets too, K-01).
  const confirmQuestion = (p: Pending): string => {
    const list = t("modules.confirm.theseTurnOffWithIt", { list: names(p.turnsOff) });
    if (
      p.id !== ROOM_ORDERS_NOWHERE_TO_RING.turningOff ||
      !p.turnsOff.includes(ROOM_ORDERS_NOWHERE_TO_RING.whileOn)
    )
      return list;
    const question = t("modules.confirm.roomOrdersNowhereToRing");
    return p.turnsOff.length > 1 ? `${question} ${list}` : question;
  };

  // "Kitchen · needs a kitchen printer and the allergy notice", naming only what's missing.
  const kitchenNeeds = (missing: readonly KitchenMissing[]): string =>
    t("kitchen.needs", {
      list: missing.map((m) => t(`kitchen.needs.${m}` as MessageKey)).join(t("kitchen.needs.and")),
    });

  // On once ready (D129): "Turns on when the allergy notice and a kitchen printer are set".
  const whenReady = (missing: readonly KitchenMissing[]): string =>
    t(
      missing.length > 1
        ? "kitchen.whenReady.both"
        : (`kitchen.whenReady.${missing[0] ?? "both"}` as MessageKey),
    );

  const names = (ids: readonly ModuleId[]): string =>
    ids.map((m) => t(`module.${m}.name` as MessageKey)).join(", ");

  // The count follows what can be switched: the four core modules are always on and stay out of it.
  const counts = rows
    ? {
        on: rows.filter((r) => !r.core && r.state === "on").length,
        off: rows.filter((r) => !r.core && r.state !== "on").length,
      }
    : null;

  return (
    <section className="features">
      {/* Set up your venue's step 2 shows the same list under its own heading (F-05; D124). */}
      {!embedded && <h2>{t("admin.section.features")}</h2>}
      {!embedded && <p className="muted">{t("admin.hint.features")}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {rows === null || counts === null ? (
        <p role="status">{t("shell.loading")}</p>
      ) : (
        <>
          <p className="small muted">
            {embedded
              ? t("onboarding.features.summary", { count: counts.on })
              : t("modules.count", counts)}
          </p>
          <ul className="module-list">
            {rows.map((m) => (
              <li key={m.id} className={`module module-${m.state}`}>
                <div className="module-head">
                  <div>
                    <h3>{t(`module.${m.id}.name` as MessageKey)}</h3>
                    {m.id === "bar_screen" && (
                      <p className="small">{t("module.bar_screen.description")}</p>
                    )}
                    {m.needs.length > 0 && (
                      <p className="small muted">
                        {t("modules.needsLabel", { list: names(m.needs) })}
                      </p>
                    )}
                    {m.allowed && m.state === "off" && (m.still_needs?.length ?? 0) > 0 && (
                      <p className="notice small" role="status">
                        {m.wanted ? whenReady(m.still_needs!) : kitchenNeeds(m.still_needs!)}
                      </p>
                    )}
                  </div>
                  <div
                    className="module-state"
                    role="group"
                    aria-label={`${t(`module.${m.id}.name` as MessageKey)} · ${t("modules.state.label")}`}
                  >
                    {m.core ? (
                      <span className="pill">{t("modules.alwaysOn")}</span>
                    ) : !m.allowed ? (
                      <span className="pill muted">{t("modules.notInPlan")}</span>
                    ) : m.state === "off" && (m.still_needs?.length ?? 0) > 0 ? (
                      // Its needs come later in setup (D129): chosen now, on by itself once they're in.
                      <>
                        <button
                          type="button"
                          className="secondary"
                          aria-pressed={m.wanted === true}
                          disabled={busy !== null || m.wanted === true}
                          onClick={() => void change(m.id, "on", false, true)}
                        >
                          {t("kitchen.whenReady.button")}
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          aria-pressed={m.wanted !== true}
                          disabled={busy !== null || m.wanted !== true}
                          onClick={() => void change(m.id, "off")}
                        >
                          {t("modules.state.off")}
                        </button>
                      </>
                    ) : (
                      STATES.map((s) => (
                        <button
                          key={s}
                          type="button"
                          className="secondary"
                          aria-pressed={m.state === s}
                          disabled={busy !== null || m.state === s}
                          onClick={() => void change(m.id, s)}
                        >
                          {t(`modules.state.${s}` as MessageKey)}
                        </button>
                      ))
                    )}
                  </div>
                </div>
                {pending?.id === m.id && (
                  <Dialog
                    role="alertdialog"
                    onClose={() => setPending(null)}
                    label={confirmQuestion(pending)}
                  >
                    <div className="sheet confirm-sheet">
                      <p>{confirmQuestion(pending)}</p>
                      <div className="actions">
                        <button
                          type="button"
                          className="primary"
                          disabled={busy !== null}
                          onClick={() => void change(pending.id, pending.state, true)}
                        >
                          {t("modules.confirm.yes")}
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => setPending(null)}
                        >
                          {t("modules.confirm.no")}
                        </button>
                      </div>
                    </div>
                  </Dialog>
                )}
                {!m.core && (
                  <dl className="module-hides">
                    <dt className="muted small">{t("modules.hidesTitle")}</dt>
                    {HIDES.map((h) => (
                      <div key={h}>
                        <dt>{t(`modules.hides.${h}` as MessageKey)}</dt>
                        <dd>{t(`module.${m.id}.hides.${h}` as MessageKey)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </li>
            ))}
          </ul>
          {venueId && <FeatureChoices venueId={venueId} />}
          {/* Menu order (P-13): Admin only; Set up your venue keeps the app's own order. */}
          {venueId && !embedded && state.status === "signedIn" && (
            <MenuOrder venueId={venueId} modules={state.membership.modules} />
          )}
        </>
      )}
    </section>
  );
}
