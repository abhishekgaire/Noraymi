import { useCallback, useEffect, useState } from "react";
import { pinAgainActions, type PinAgainAction } from "@west4/shared";
import { api, type ApiCallError } from "../../api.js";
import { useEvents } from "../../events.js";
import { useT } from "../../i18n.js";

/**
 * Admin → Features → Choices → Ask for the PIN again for (P-10; spec 02 · PINs): the actions on which
 * staff in a PIN or badge session type their own PIN again, even when signed in. The owner's alone,
 * saved at once to `pinAgain`; the API asks for it, the screens only show the question. The
 * default keeps what was there before: only no-sale.
 */
export function PinAgainChoices({ venueId, isOwner }: { venueId: string; isOwner: boolean }) {
  const { t } = useT();
  const { subscribe } = useEvents();
  const [actions, setActions] = useState<readonly PinAgainAction[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ value: { actions: PinAgainAction[] } }>(
        "GET",
        `/v1/venues/${venueId}/settings/pinAgain`,
      );
      setActions(r.value.actions);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [venueId]);
  useEffect(() => {
    if (venueId) void load();
  }, [venueId, load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (events.some((e) => e.type === "settings.changed")) void load();
      }),
    [subscribe, load],
  );

  const toggle = async (action: PinAgainAction, on: boolean) => {
    if (!actions) return;
    setError(null);
    // Kept in the list's own order, whatever order they were ticked in.
    const next = pinAgainActions.filter((a) => (a === action ? on : actions.includes(a)));
    setActions(next);
    try {
      await api("PUT", `/v1/venues/${venueId}/settings/pinAgain`, { value: { actions: next } });
    } catch (e) {
      setError((e as ApiCallError)?.message ?? t("pinAgain.saveFailed"));
      await load();
    }
  };

  return (
    <fieldset className="pin-again-choices">
      <legend>
        <h4>{t("pinAgain.choices")}</h4>
      </legend>
      <p className="small muted">{t("pinAgain.choices.hint")}</p>
      <p className="small muted relates">{t("admin.relates.pinAgainInChoices")}</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {failed ? (
        <p className="error" role="alert">
          {t("pinAgain.loadFailed")}
        </p>
      ) : actions === null ? (
        <span role="status">{t("shell.loading")}</span>
      ) : (
        pinAgainActions.map((a) => (
          <label key={a} className="check">
            <input
              type="checkbox"
              checked={actions.includes(a)}
              disabled={!isOwner}
              onChange={(e) => void toggle(a, e.target.checked)}
            />{" "}
            {t(`pinAgain.action.${a}`)}
          </label>
        ))
      )}
      {!isOwner && <p className="small muted">{t("pinAgain.ownerOnly")}</p>}
    </fieldset>
  );
}
