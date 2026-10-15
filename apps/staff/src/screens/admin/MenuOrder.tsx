import { useCallback, useEffect, useMemo, useState } from "react";
import {
  inMenuOrder,
  staffMenuIds,
  type MenuOrderSettings,
  type ModuleStates,
} from "@west4/shared";
import { api, type ApiCallError } from "../../api.js";
import { useEvents } from "../../events.js";
import { useT } from "../../i18n.js";
import { hiddenScreens, menu, type MenuEntry } from "../../navigation.js";

/**
 * Admin → Features → Menu order (P-13; spec 03 · Menu order): the side menu's entries for the
 * venue, moved up and down and saved to the `menuOrder` key. Everyone at the venue gets it in
 * their menu at once (`settings.changed` reloads the session); each role still sees only what it
 * may open. Lock isn't listed: it stays last. An entry a switched-off feature hides is listed
 * too, marked, so its place is kept for when the feature comes back on.
 */
const movable: readonly MenuEntry[] = menu.filter(
  (e) => e.shipped && (staffMenuIds as readonly string[]).includes(e.id),
);

export function MenuOrder({ venueId, modules }: { venueId: string; modules: ModuleStates }) {
  const { t } = useT();
  const { subscribe } = useEvents();
  const [saved, setSaved] = useState<readonly string[] | null>(null);
  const [draft, setDraft] = useState<readonly string[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api<{ value: MenuOrderSettings }>(
        "GET",
        `/v1/venues/${venueId}/settings/menuOrder`,
      );
      const ids = inMenuOrder(movable, r.value.order).map((e) => e.id);
      setSaved(ids);
      setDraft((d) => d ?? ids);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [venueId]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (events.some((e) => e.type === "settings.changed")) void load();
      }),
    [subscribe, load],
  );

  const hidden = useMemo(() => hiddenScreens(modules), [modules]);
  const byId = useMemo(() => new Map(movable.map((e) => [e.id, e])), []);
  const changed = saved !== null && draft !== null && draft.join() !== saved.join();
  const appOrder = movable.map((e) => e.id);

  const move = (index: number, by: -1 | 1) => {
    if (!draft) return;
    const next = [...draft];
    const [id] = next.splice(index, 1);
    next.splice(index + by, 0, id!);
    setDraft(next);
    setDone(false);
  };

  const save = async (order: readonly string[]) => {
    setError(null);
    setDone(false);
    setBusy(true);
    try {
      // The app's own order saves as an empty list, so an entry added to the app later takes its own place.
      const value = { order: order.join() === appOrder.join() ? [] : order };
      await api("PUT", `/v1/venues/${venueId}/settings/menuOrder`, { value });
      setSaved(order);
      setDraft(order);
      setDone(true);
    } catch (e) {
      setError((e as ApiCallError)?.message ?? t("menuOrder.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="menu-order" aria-labelledby="menu-order">
      <h3 id="menu-order">{t("menuOrder.title")}</h3>
      <p className="small muted">{t("menuOrder.hint")}</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {draft === null ? (
        failed ? (
          <p className="error" role="alert">
            {t("menuOrder.cantLoad")}{" "}
            <button type="button" className="secondary" onClick={() => void load()}>
              {t("shell.error.retry")}
            </button>
          </p>
        ) : (
          <p role="status">{t("shell.loading")}</p>
        )
      ) : (
        <>
          <ol className="module-list menu-order-list" data-testid="menu-order">
            {draft.map((id, i) => {
              const entry = byId.get(id)!;
              const name = t(entry.labelKey);
              return (
                <li key={id} className="module menu-order-row" data-entry={id}>
                  <span className="menu-order-name">
                    <span className="muted small">{i + 1}.</span> {name}
                    {hidden.has(entry.screen) && (
                      <span className="small muted"> · {t("menuOrder.featureOff")}</span>
                    )}
                  </span>
                  <span className="menu-order-moves">
                    <button
                      type="button"
                      className="secondary"
                      aria-label={t("menuOrder.up", { name })}
                      disabled={busy || i === 0}
                      onClick={() => move(i, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      aria-label={t("menuOrder.down", { name })}
                      disabled={busy || i === draft.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      ↓
                    </button>
                  </span>
                </li>
              );
            })}
          </ol>
          <div className="menu-order-actions">
            <button
              type="button"
              className="primary"
              disabled={busy || !changed}
              onClick={() => void save(draft)}
            >
              {t("menuOrder.save")}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy || draft.join() === appOrder.join()}
              onClick={() => {
                setDraft(appOrder);
                setDone(false);
              }}
            >
              {t("menuOrder.reset")}
            </button>
            {changed && <span className="small muted">{t("menuOrder.unsaved")}</span>}
            {done && !changed && (
              <span className="small" role="status">
                {t("menuOrder.saved")}
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
