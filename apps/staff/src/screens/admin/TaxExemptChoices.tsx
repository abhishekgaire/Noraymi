import { useCallback, useEffect, useState } from "react";
import { taxCategories, TAX_EXEMPT_DEFAULTS } from "@west4/shared";
import { api, type ApiCallError } from "../../api.js";
import { useEvents } from "../../events.js";
import { useT } from "../../i18n.js";
import { useModuleOn } from "../../useModule.js";

type Category = (typeof taxCategories)[number];

/**
 * Admin → Features → Choices → Taxed even on a tax-exempt check (P-15; Money rules 8): the tax
 * categories that stay taxed on a check made tax exempt, saved at once to `taxExempt`. Which sales an
 * exemption covers is the accountant's call; the default keeps drinks taxed. Shown while Tax-exempt
 * sales is on; an exemption already given keeps the list it was given with.
 */
export function TaxExemptChoices({ venueId }: { venueId: string }) {
  const { t } = useT();
  const { subscribe } = useEvents();
  const on = useModuleOn("tax_exempt");
  const [taxed, setTaxed] = useState<readonly Category[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ value: { stillTaxed: Category[] } | null }>(
        "GET",
        `/v1/venues/${venueId}/settings/taxExempt`,
      );
      setTaxed(r.value?.stillTaxed ?? TAX_EXEMPT_DEFAULTS.stillTaxed);
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

  const toggle = async (cat: Category, keep: boolean) => {
    if (!taxed) return;
    setError(null);
    const next = taxCategories.filter((c) => (c === cat ? keep : taxed.includes(c)));
    setTaxed(next);
    try {
      await api("PUT", `/v1/venues/${venueId}/settings/taxExempt`, {
        value: { stillTaxed: next },
      });
    } catch (e) {
      setError((e as ApiCallError)?.message ?? t("taxExempt.saveFailed"));
      await load();
    }
  };

  return (
    <fieldset className="tax-exempt-choices">
      <legend>
        <h4>{t("taxExempt.choices")}</h4>
      </legend>
      <p className="small muted">{t("taxExempt.choices.hint")}</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {failed ? (
        <p className="error" role="alert">
          {t("taxExempt.loadFailed")}
        </p>
      ) : taxed === null ? (
        <span role="status">{t("shell.loading")}</span>
      ) : (
        taxCategories.map((c) => (
          <label key={c} className="check">
            <input
              type="checkbox"
              checked={taxed.includes(c)}
              onChange={(e) => void toggle(c, e.target.checked)}
            />{" "}
            {t(`taxExempt.category.${c}`)}
          </label>
        ))
      )}
    </fieldset>
  );
}
