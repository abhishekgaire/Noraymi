import { useCallback, useEffect, useState } from "react";
import {
  ROOM_ORDERS_NOWHERE_TO_RING,
  type MessageKey,
  type ModuleId,
  type ModuleState,
} from "@west4/shared";
import { api, type ApiCallError } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";

/**
 * Admin → Features (M1-32; spec 03 · Modules, What each module hides;
 * AdminDesk notes 11, 12 and 22). Every phase 1 module within what the
 * Console allows, with its state (on, stopping or off), what it needs and
 * what turning it off hides. Core modules read "Always on"; a module the plan
 * doesn't allow reads "Not in your plan". Turning one off that others need
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
}

type PatchAnswer =
  | { applied: true }
  | { applied: false; unchanged: true }
  | { applied: false; needs_confirm: true; turns_off: ModuleId[] };

interface Pending {
  readonly id: ModuleId;
  readonly state: ModuleState;
  readonly turnsOff: readonly ModuleId[];
}

const STATES: readonly ModuleState[] = ["on", "stopping", "off"];
const HIDES = ["staffApp", "staffPhone", "website", "texts"] as const;

export function Features() {
  const { t } = useT();
  const { state, refresh } = useSession();
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

  const change = async (id: ModuleId, next: ModuleState, confirm = false) => {
    setError(null);
    setBusy(id);
    try {
      const answer = await api<PatchAnswer>(
        "PATCH",
        `/v1/venues/${venueId}/modules/${id}`,
        confirm ? { state: next, confirm: true } : { state: next },
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

  const confirmQuestion = (p: Pending): string =>
    p.id === ROOM_ORDERS_NOWHERE_TO_RING.turningOff &&
    p.turnsOff.includes(ROOM_ORDERS_NOWHERE_TO_RING.whileOn)
      ? t("modules.confirm.roomOrdersNowhereToRing")
      : t("modules.confirm.theseTurnOffWithIt", { list: names(p.turnsOff) });

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
      <h2>{t("admin.section.features")}</h2>
      <p className="muted">{t("admin.hint.features")}</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {rows === null || counts === null ? (
        <p role="status">{t("shell.loading")}</p>
      ) : (
        <>
          <p className="small muted">{t("modules.count", counts)}</p>
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
                  <p className="notice" role="alertdialog">
                    {confirmQuestion(pending)}
                    <button
                      type="button"
                      className="primary"
                      disabled={busy !== null}
                      onClick={() => void change(pending.id, pending.state, true)}
                    >
                      {t("modules.confirm.yes")}
                    </button>
                    <button type="button" className="secondary" onClick={() => setPending(null)}>
                      {t("modules.confirm.no")}
                    </button>
                  </p>
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
        </>
      )}
    </section>
  );
}
