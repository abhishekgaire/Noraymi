import { useCallback, useEffect, useState } from "react";
import { KITCHEN_SCREEN_DEFAULTS } from "@west4/shared";
import { api, type ApiCallError } from "../../api.js";
import { useEvents } from "../../events.js";
import { useT } from "../../i18n.js";
import { useModuleOn } from "../../useModule.js";

/**
 * Admin → Features → Choices → Kitchen screen (P-17): whether the kitchen printer keeps printing
 * beside the screen (`kitchenScreen.print`, on by default), saved at once. Shown while the screen is on.
 */
export function KitchenScreenChoices({ venueId }: { venueId: string }) {
  const { t } = useT();
  const { subscribe } = useEvents();
  const on = useModuleOn("kitchen_screen");
  const [print, setPrint] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ value: { print: boolean } | null }>(
        "GET",
        `/v1/venues/${venueId}/settings/kitchenScreen`,
      );
      setPrint(r.value?.print ?? KITCHEN_SCREEN_DEFAULTS.print);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [venueId]);
  useEffect(() => {
    if (venueId && on) void load();
  }, [venueId, on, load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (events.some((e) => e.type === "settings.changed")) void load();
      }),
    [subscribe, load],
  );
  if (!on) return null;

  const toggle = async (next: boolean) => {
    setError(null);
    setPrint(next);
    try {
      await api("PUT", `/v1/venues/${venueId}/settings/kitchenScreen`, {
        value: { print: next },
      });
    } catch (e) {
      setError((e as ApiCallError)?.message ?? t("kitchenScreen.saveFailed"));
      await load();
    }
  };

  return (
    <fieldset className="kitchen-screen-choices">
      <legend>
        <h4>{t("kitchenScreen.choices")}</h4>
      </legend>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {failed ? (
        <p className="error" role="alert">
          {t("kitchenScreen.loadFailed")}
        </p>
      ) : print === null ? (
        <span role="status">{t("shell.loading")}</span>
      ) : (
        <label className="check">
          <input type="checkbox" checked={print} onChange={(e) => void toggle(e.target.checked)} />{" "}
          {t("kitchenScreen.print")}
        </label>
      )}
      <p className="small muted">{t("kitchenScreen.print.hint")}</p>
    </fieldset>
  );
}
