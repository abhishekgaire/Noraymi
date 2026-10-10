import { useCallback, useEffect, useState } from "react";
import { api, ApiCallError } from "../api.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";
import { useSession } from "../session.js";
import "./bar.css";

interface KitchenNow {
  readonly last_order: string | null;
  readonly stop: "kitchen_closed" | "last_order" | null;
}

/**
 * Close the kitchen and Reopen the kitchen (K-07; Kitchen and food · 86 and closing the kitchen),
 * on the bar POS's Food row and the manager's phone. Everyone sees "Kitchen closed" while food is
 * stopped; only managers and the owner (night.close) get the button. Renders nothing while
 * Kitchen & food is off (the kitchen routes answer module_off).
 */
export function KitchenSwitch({ compact = false }: { compact?: boolean }) {
  const { t, time } = useT();
  const { state } = useSession();
  const { subscribe } = useEvents();
  const signedIn = state.status === "signedIn" ? state : null;
  const venueId = signedIn?.membership.venue_id ?? "";
  const canSwitch = signedIn?.membership.permissions.includes("night.close") ?? false;
  const [now, setNow] = useState<KitchenNow | null>(null);
  const [off, setOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!venueId) return;
    try {
      setNow(await api<KitchenNow>("GET", `/v1/venues/${venueId}/kitchen`));
      setOff(false);
    } catch (e) {
      if (e instanceof ApiCallError && (e.status === 404 || e.status === 403)) setOff(true);
    }
  }, [venueId]);
  useEffect(() => void load(), [load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (
          events.length === 0 ||
          events.some((e) => e.type === "menu.changed" || e.type === "settings.changed")
        )
          void load();
      }),
    [subscribe, load],
  );

  if (off || !venueId) return null;
  if (!now)
    return compact ? null : (
      <p className="small muted" role="status">
        {t("shell.loading")}
      </p>
    );
  const closed = now.stop === "kitchen_closed";
  const status =
    now.stop === "last_order" && now.last_order
      ? t("kitchen.closed.lastOrder", {
          time: time(`2000-01-01T${now.last_order}:00Z`, "UTC"),
        })
      : now.stop
        ? t("kitchen.closed")
        : null;

  const flip = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(
        "POST",
        `/v1/venues/${venueId}/kitchen/${closed ? "reopen" : "close"}`,
        {},
        { idempotencyKey: crypto.randomUUID() },
      );
      await load();
    } catch (e) {
      setError(e instanceof ApiCallError ? e.message : t("kitchen.switch.failed"));
    }
    setBusy(false);
  };

  return (
    <div className="kitchen-switch" data-testid="kitchen-switch">
      {status && (
        <span className="chip warn" role="status">
          {status}
        </span>
      )}
      {canSwitch && (
        <button
          type="button"
          className="secondary"
          disabled={busy}
          title={closed ? undefined : t("kitchen.close.hint")}
          onClick={() => void flip()}
        >
          {closed ? t("kitchen.reopen") : t("kitchen.close")}
        </button>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
