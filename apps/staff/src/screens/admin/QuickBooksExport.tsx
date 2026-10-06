import { useCallback, useEffect, useState } from "react";
import type { MessageKey, PaySettings } from "@west4/shared";
import { useAdminDraft } from "../../admin/draft.js";
import { api, stepUpToken } from "../../api.js";
import { useT } from "../../i18n.js";

/**
 * Admin → Connections · Export for QuickBooks (M7-15; screens AdminDesk note
 * 21): no live QuickBooks connection. The owner names each account as it is
 * in West 4's chart of accounts and sets where the nightly file is emailed
 * (both saved with the `pay` key through Save and publish), and downloads a
 * closed night's file, which asks for the passkey again.
 */
const ACCOUNTS = [
  "sales_room_time",
  "sales_drinks",
  "sales_packages",
  "sales_songs",
  "sales_damage",
  "sales_deposits_kept",
  "comps",
  "refunds",
  "sales_tax_payable",
  "gratuity_payable",
  "tips_payable",
  "customer_deposits",
  "prepaid_value",
  "stripe_clearing",
  "cash",
  "cash_over_short",
  "unmatched_suspense",
  "due_from_guests",
  "bank",
  "stripe_fees",
  "disputes",
] as const;

export function QuickBooksExport({ venueId }: { venueId: string }) {
  const { t } = useT();
  const draft = useAdminDraft();
  const [saved, setSaved] = useState<PaySettings | null>(null);
  const [date, setDate] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(async () => {
    setSaved(
      (await api<{ value: PaySettings }>("GET", `/v1/venues/${venueId}/settings/pay`)).value,
    );
  }, [venueId]);
  useEffect(() => {
    load().catch(() => setNotice(t("shell.error.cantReach")));
  }, [load, draft.version, t]);
  const current = (draft.values["pay"] as PaySettings | undefined) ?? saved;
  if (!current) return null;
  const accounting = current.accounting ?? {};
  const set = (next: NonNullable<PaySettings["accounting"]>) =>
    draft.set("pay", { ...current, accounting: { ...accounting, ...next } });

  const download = async () => {
    setNotice(null);
    try {
      const r = await api<{ file: string; filename: string }>(
        "GET",
        `/v1/venues/${venueId}/exports/accounting?date=${date}`,
        undefined,
        { stepUp: await stepUpToken() },
      );
      const url = URL.createObjectURL(new Blob([r.file], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = r.filename;
      a.click();
      URL.revokeObjectURL(url);
      setNotice(t("qb.downloaded"));
    } catch {
      setNotice(t("qb.failed"));
    }
  };
  return (
    <section className="qb-export" aria-labelledby="qb-title">
      <h3 id="qb-title">{t("qb.title")}</h3>
      <p className="small muted">{t("qb.hint")}</p>
      <label>
        <span>{t("qb.emailTo")}</span>
        <input
          aria-label={t("qb.emailTo")}
          defaultValue={(accounting.emailTo ?? []).join(", ")}
          onBlur={(e) =>
            set({
              emailTo: e.target.value
                .split(",")
                .map((x) => x.trim())
                .filter(Boolean),
            })
          }
        />
      </label>
      <details>
        <summary>{t("qb.accounts")}</summary>
        <div className="invite-fields">
          {ACCOUNTS.map((a) => (
            <label key={a}>
              <span>{t(`qb.account.${a}` as MessageKey)}</span>
              <input
                aria-label={t(`qb.account.${a}` as MessageKey)}
                defaultValue={accounting.accounts?.[a] ?? ""}
                placeholder={t(`qb.account.${a}` as MessageKey)}
                onBlur={(e) => {
                  const accounts = { ...(accounting.accounts ?? {}) };
                  if (e.target.value.trim()) accounts[a] = e.target.value.trim();
                  else delete accounts[a];
                  set({ accounts });
                }}
              />
            </label>
          ))}
        </div>
      </details>
      <div className="actions">
        <input
          type="date"
          aria-label={t("qb.night")}
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <button type="button" disabled={!date} onClick={() => void download()}>
          {t("qb.download")}
        </button>
      </div>
      {notice && (
        <p role="status" className="small">
          {notice}
        </p>
      )}
    </section>
  );
}
