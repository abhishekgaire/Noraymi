import { useCallback, useEffect, useState } from "react";
import type { PosSettings } from "@west4/shared";
import { useAdminDraft } from "../../admin/draft.js";
import { api } from "../../api.js";
import { useT } from "../../i18n.js";
import { dollarsToCents } from "./Prices.js";

const MAX_CENTS = 1_000_000;
const centsText = (c: number) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;

/**
 * Admin → Payments · Refund alerts (D104; spec 02 · On the record): refunds over this amount alert
 * the owner. Empty, the default, alerts on every refund. It's part of the `pos` key, saved with
 * Save and publish, and only the owner may change it (the server refuses anyone else).
 */
export function RefundAlerts({ venueId }: { venueId: string }) {
  const { t } = useT();
  const draft = useAdminDraft();
  const [saved, setSaved] = useState<PosSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [text, setText] = useState<string | null>(null);

  const load = useCallback(async () => {
    const p = await api<{ value: PosSettings }>("GET", `/v1/venues/${venueId}/settings/pos`);
    setSaved(p.value);
  }, [venueId]);
  useEffect(() => {
    if (!venueId) return;
    load().catch(() => setFailed(true));
  }, [venueId, load, draft.version]);

  if (failed)
    return (
      <p className="error" role="alert">
        {t("shell.error.cantReach")}
      </p>
    );
  if (!saved) return <p role="status">{t("shell.loading")}</p>;

  const pos = (draft.values["pos"] as PosSettings | undefined) ?? saved;
  const shown =
    text ?? (pos.refundAlertOverCents === undefined ? "" : centsText(pos.refundAlertOverCents));
  const cents = shown.trim() === "" ? null : dollarsToCents(shown);
  const ok = shown.trim() === "" || (cents !== null && cents <= MAX_CENTS);

  return (
    <div className="refund-alerts">
      <h3>{t("refundAlerts.title")}</h3>
      <div className="invite-fields">
        <label>
          <span>{t("refundAlerts.label")}</span>
          <input
            inputMode="decimal"
            aria-label={t("refundAlerts.label")}
            placeholder={t("refundAlerts.placeholder")}
            value={shown}
            aria-invalid={!ok}
            onChange={(e) => {
              const next = e.target.value;
              setText(next);
              if (next.trim() === "") {
                const rest: PosSettings = { ...pos };
                delete rest.refundAlertOverCents;
                draft.set("pos", rest);
                return;
              }
              const c = dollarsToCents(next);
              if (c !== null && c <= MAX_CENTS)
                draft.set("pos", { ...pos, refundAlertOverCents: c });
            }}
          />
        </label>
      </div>
      {!ok && (
        <p className="error" role="alert">
          {t("refundAlerts.invalid")}
        </p>
      )}
      <p className="small muted">{t("refundAlerts.hint")}</p>
    </div>
  );
}
