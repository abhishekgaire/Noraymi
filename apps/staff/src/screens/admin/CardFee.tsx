import { useCallback, useEffect, useState } from "react";
import { Temporal, type SettingsValue } from "@west4/shared";
import { cardFee } from "@west4/rules";
import { useAdminDraft } from "../../admin/draft.js";
import { api } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";

/**
 * Admin → Card fee & gratuity (M4-26; spec 03 · PaySettings; screens
 * AdminDesk notes 18 and 26): the card fee (off at West 4) with a preview
 * whose tax line follows the rule pack's `surchargeTaxable`; the gratuity,
 * always called "Gratuity"; the reader's tip screen (a save updates the
 * readers, which can take up to 5 minutes); tip review; and Pay my share.
 * Saved through Save and publish; a card-fee change asks for the passkey again.
 */
type Pay = SettingsValue<"pay">;
interface Pack {
  readonly current: { readonly sales_tax: { rate: number; surcharge_taxable: boolean } } | null;
}

/** 0.08875 → "8.875", digits moved, no float. */
function pctOf(rate: number): string {
  const [whole, frac = ""] = String(rate).split(".");
  const digits = (whole! + frac.padEnd(2, "0")).replace(/^0+(?=\d)/, "");
  const point = digits.length - Math.max(0, frac.length - 2);
  const out = frac.length > 2 ? `${digits.slice(0, point)}.${digits.slice(point)}` : digits;
  return out.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

export function CardFee() {
  const { t, money, date } = useT();
  const { state } = useSession();
  const draft = useAdminDraft();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : "";
  const [saved, setSaved] = useState<Pay | null>(null);
  const [today, setToday] = useState<string | null>(null);
  const [pack, setPack] = useState<Pack | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const [p, r] = await Promise.all([
      api<{ value: Pay; business_date: string }>("GET", `/v1/venues/${venueId}/settings/pay`),
      api<Pack>("GET", `/v1/venues/${venueId}/rule-pack`),
    ]);
    setSaved(p.value);
    setToday(p.business_date);
    setPack(r);
  }, [venueId]);
  useEffect(() => {
    if (!venueId) return;
    load().catch(() => setFailed(true));
  }, [venueId, load, draft.version]);

  const current = (draft.values["pay"] as Pay | undefined) ?? saved;
  const set = (next: Pay) => draft.set("pay", next);
  const num = (raw: string) => (raw === "" || !Number.isFinite(Number(raw)) ? null : Number(raw));
  const tax = pack?.current?.sales_tax;
  const preview =
    current && current.cardFee.mode === "surcharge" && tax
      ? cardFee({
          amountCents: 10000,
          ratePct: current.cardFee.pct,
          taxRatePct: pctOf(tax.rate),
          funding: "credit",
        })
      : null;

  return (
    <section className="card-fee-admin">
      <h2>{t("admin.section.cardFee")}</h2>
      {failed && (
        <p className="error" role="alert">
          {t("shell.error.cantReach")}
        </p>
      )}
      {current === null ? (
        !failed && <p role="status">{t("shell.loading")}</p>
      ) : (
        <>
          <fieldset>
            <legend>{t("cardFeeAdmin.fee")}</legend>
            {(["off", "surcharge", "discount"] as const).map((mode) => (
              <label key={mode}>
                <input
                  type="radio"
                  name="card-fee"
                  checked={current.cardFee.mode === mode}
                  onChange={() =>
                    set({
                      ...current,
                      cardFee:
                        mode === "off"
                          ? { mode: "off" }
                          : mode === "surcharge"
                            ? { mode: "surcharge", pct: 0, noticeSentOn: null }
                            : { mode: "discount", pct: 0 },
                    })
                  }
                />
                <span>{t(`cardFeeAdmin.mode.${mode}`)}</span>
              </label>
            ))}
            {current.cardFee.mode !== "off" && (
              <label>
                <span>{t("cardFeeAdmin.pct")}</span>
                <input
                  inputMode="decimal"
                  aria-label={t("cardFeeAdmin.pct")}
                  value={current.cardFee.pct}
                  onChange={(e) => {
                    const n = num(e.target.value);
                    if (n !== null && current.cardFee.mode !== "off")
                      set({ ...current, cardFee: { ...current.cardFee, pct: n } });
                  }}
                />
              </label>
            )}
            {current.cardFee.mode === "surcharge" && (
              <label>
                <span>{t("cardFeeAdmin.notice")}</span>
                <input
                  type="date"
                  aria-label={t("cardFeeAdmin.notice")}
                  value={current.cardFee.noticeSentOn ?? ""}
                  onChange={(e) =>
                    current.cardFee.mode === "surcharge" &&
                    set({
                      ...current,
                      cardFee: { ...current.cardFee, noticeSentOn: e.target.value || null },
                    })
                  }
                />
              </label>
            )}
            {preview && (
              <p className="small" aria-label={t("cardFeeAdmin.preview")}>
                {t("cardFeeAdmin.previewLine", { fee: money(preview.surchargeCents as never) })}
                {tax?.surcharge_taxable &&
                  ` · ${t("cardFeeAdmin.previewTax", { tax: money(preview.taxOnSurchargeCents as never) })}`}
                {` · ${t("cardFeeAdmin.previewTotal", {
                  total: money(
                    (tax?.surcharge_taxable
                      ? preview.cardPaysWithTaxOnFeeCents
                      : preview.cardPaysCents) as never,
                  ),
                })}`}
              </p>
            )}
            {current.cardFee.mode === "off" && (
              <p className="small muted">{t("cardFeeAdmin.off")}</p>
            )}
          </fieldset>

          <fieldset>
            <legend>{t("cardFeeAdmin.gratuity")}</legend>
            <label>
              <span>{t("cardFeeAdmin.gratuity.auto")}</span>
              <select
                value={current.gratuity.auto}
                onChange={(e) =>
                  set({
                    ...current,
                    gratuity: {
                      ...current.gratuity,
                      auto: e.target.value as Pay["gratuity"]["auto"],
                    },
                  })
                }
              >
                {(["off", "rooms", "parties", "all"] as const).map((a) => (
                  <option key={a} value={a}>
                    {t(`cardFeeAdmin.gratuity.${a}`)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{t("cardFeeAdmin.gratuity.pct")}</span>
              <input
                inputMode="decimal"
                aria-label={t("cardFeeAdmin.gratuity.pct")}
                value={current.gratuity.pct}
                onChange={(e) => {
                  const n = num(e.target.value);
                  if (n !== null) set({ ...current, gratuity: { ...current.gratuity, pct: n } });
                }}
              />
            </label>
            {current.gratuity.auto === "parties" && (
              <label>
                <span>{t("cardFeeAdmin.gratuity.partyMin")}</span>
                <input
                  inputMode="numeric"
                  aria-label={t("cardFeeAdmin.gratuity.partyMin")}
                  value={current.gratuity.partyMin ?? ""}
                  onChange={(e) => {
                    const n = num(e.target.value);
                    if (n !== null && Number.isInteger(n) && n > 0)
                      set({ ...current, gratuity: { ...current.gratuity, partyMin: n } });
                  }}
                />
              </label>
            )}
          </fieldset>

          <fieldset>
            <legend>{t("cardFeeAdmin.tips")}</legend>
            <label>
              <input
                type="checkbox"
                checked={current.tipScreen.on}
                onChange={(e) =>
                  set({ ...current, tipScreen: { ...current.tipScreen, on: e.target.checked } })
                }
              />
              <span>{t("cardFeeAdmin.tips.on")}</span>
            </label>
            {current.tipScreen.pcts.map((p, i) => (
              <label key={`pct-${i}`}>
                <span>{t("cardFeeAdmin.tips.pct", { n: i + 1 })}</span>
                <input
                  inputMode="decimal"
                  aria-label={t("cardFeeAdmin.tips.pct", { n: i + 1 })}
                  value={p}
                  onChange={(e) => {
                    const n = num(e.target.value);
                    if (n === null) return;
                    const pcts = [...current.tipScreen.pcts] as [number, number, number];
                    pcts[i] = n;
                    set({ ...current, tipScreen: { ...current.tipScreen, pcts } });
                  }}
                />
              </label>
            ))}
            <p className="small muted">
              {t("cardFeeAdmin.tips.small", {
                amounts: current.tipScreen.fixedCents.map((c) => money(c as never)).join(", "),
                under: money(current.tipScreen.smartThresholdCents as never),
              })}
            </p>
            <p className="small muted">{t("cardFeeAdmin.tips.readers")}</p>
          </fieldset>

          <fieldset>
            <legend>{t("cardFeeAdmin.review")}</legend>
            <p>
              {t("cardFeeAdmin.review.line", {
                pct: current.tipReview.overPct,
                amount: money(current.tipReview.overCents as never),
                hours: current.tipReview.lateHours,
              })}
            </p>
          </fieldset>

          <label>
            <input
              type="checkbox"
              checked={current.payShare.on}
              onChange={(e) => set({ ...current, payShare: { on: e.target.checked } })}
            />
            <span>{t("cardFeeAdmin.payShare")}</span>
          </label>

          {/* Who gets tips and gratuity (M7-09): the pool method starts the next business date. */}
          <fieldset>
            <legend>{t("pool.title")}</legend>
            <label>
              <span>{t("pool.method")}</span>
              <select
                aria-label={t("pool.method")}
                value={current.pool}
                onChange={(e) => set({ ...current, pool: e.target.value as Pay["pool"] })}
              >
                <option value="hours">{t("pool.method.hours")}</option>
                <option value="even">{t("pool.method.even")}</option>
                <option value="roomServer">{t("pool.method.roomServer")}</option>
              </select>
            </label>
            {saved && today && current.pool !== saved.pool && (
              <p role="status" className="notice">
                {t("cashAdmin.startsOn", {
                  date: date(Temporal.PlainDate.from(today).add({ days: 1 })),
                })}
              </p>
            )}
            <p className="small muted">
              {(current.occupations ?? []).length === 0
                ? t("pool.occupations.none")
                : (current.occupations ?? []).map((o) => `${o.code} ${o.sharePct}%`).join(" · ")}
            </p>
            <label>
              <span>{t("pool.refunded")}</span>
              <select
                aria-label={t("pool.refunded")}
                value={current.refundedGratuity ?? "house"}
                onChange={(e) =>
                  set({
                    ...current,
                    refundedGratuity: e.target.value as NonNullable<Pay["refundedGratuity"]>,
                  })
                }
              >
                <option value="house">{t("pool.refunded.house")}</option>
                <option value="nextPool">{t("pool.refunded.nextPool")}</option>
              </select>
            </label>
            <p className="small muted">{t("pool.managers")}</p>
          </fieldset>
        </>
      )}
    </section>
  );
}
