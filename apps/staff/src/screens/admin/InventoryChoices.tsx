import { useCallback, useEffect, useState } from "react";
import { INVENTORY_DEFAULTS } from "@west4/shared";
import { api, type ApiCallError } from "../../api.js";
import { useEvents } from "../../events.js";
import { useT } from "../../i18n.js";
import { useModuleOn } from "../../useModule.js";

/**
 * Admin → Features → Choices → Inventory (P-16): whether a sale that takes an item's count to zero
 * 86's it (`inventory.autoEightySix`, on by default), saved at once. Shown while Inventory is on.
 */
export function InventoryChoices({ venueId }: { venueId: string }) {
  const { t } = useT();
  const { subscribe } = useEvents();
  const on = useModuleOn("inventory");
  const [auto, setAuto] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ value: { autoEightySix: boolean } | null }>(
        "GET",
        `/v1/venues/${venueId}/settings/inventory`,
      );
      setAuto(r.value?.autoEightySix ?? INVENTORY_DEFAULTS.autoEightySix);
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
    setAuto(next);
    try {
      await api("PUT", `/v1/venues/${venueId}/settings/inventory`, {
        value: { autoEightySix: next },
      });
    } catch (e) {
      setError((e as ApiCallError)?.message ?? t("stock.saveFailed"));
      await load();
    }
  };

  return (
    <fieldset className="inventory-choices">
      <legend>
        <h4>{t("stock.choices")}</h4>
      </legend>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {failed ? (
        <p className="error" role="alert">
          {t("stock.loadFailed")}
        </p>
      ) : auto === null ? (
        <span role="status">{t("shell.loading")}</span>
      ) : (
        <label className="check">
          <input type="checkbox" checked={auto} onChange={(e) => void toggle(e.target.checked)} />{" "}
          {t("stock.autoEightySix")}
        </label>
      )}
      <p className="small muted">{t("stock.autoEightySix.hint")}</p>
    </fieldset>
  );
}
