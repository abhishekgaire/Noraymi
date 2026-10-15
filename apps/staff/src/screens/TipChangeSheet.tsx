import { useCallback, useEffect, useState, type FormEvent } from "react";
import { parseDollars } from "@west4/shared";
import { api, type ApiCallError } from "../api.js";
import { useT } from "../i18n.js";

/**
 * Change tip (P-06; Payment flows · Outside card machine · Change tip): a check's payments, each with
 * its tip. An outside card machine payment's tip is fixed to match the machine; a held card waiting
 * for its slip has its tip typed again. A Stripe card already charged shows why it can't change.
 * Past the tip checks it waits for the approver ("Waiting for Abhishek").
 */
interface TipRow {
  readonly payment_id: string;
  readonly method: string;
  readonly label: string | null;
  readonly amount_cents: number;
  readonly tip_cents: number;
  readonly change: "outside" | "held" | null;
  readonly refused: string | null;
  readonly waiting_for: string | null;
}

type Refusal =
  | "captured_card"
  | "cash"
  | "refunded"
  | "not_changeable"
  | "unchanged"
  | "tip_waiting"
  | "outside_card_off";
const REFUSALS: readonly Refusal[] = [
  "captured_card",
  "cash",
  "refunded",
  "not_changeable",
  "unchanged",
  "tip_waiting",
  "outside_card_off",
];

/** Typed dollars as cents through the shared parser, never a float (U-06). */
const toCents = (text: string): number | null => parseDollars(text, 4);

export function TipChangeSheet({
  venueId,
  checkId,
  onClose,
}: {
  venueId: string;
  checkId: string;
  onClose: () => void;
}) {
  const { t, money } = useT();
  const [rows, setRows] = useState<readonly TipRow[] | null>(null);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    () =>
      api<{ payments: TipRow[] }>("GET", `/v1/venues/${venueId}/checks/${checkId}/tips`)
        .then((r) => setRows(r.payments))
        .catch(() => setProblem(t("tipChange.failed"))),
    [venueId, checkId, t],
  );
  useEffect(() => void load(), [load]);

  const why = (reason: string | null) =>
    REFUSALS.includes(reason as Refusal)
      ? t(`tipChange.refused.${reason as Refusal}`)
      : t("tipChange.refused.not_changeable");

  const save = async (e: FormEvent, row: TipRow) => {
    e.preventDefault();
    const tip = toCents(typed[row.payment_id] ?? "");
    if (tip === null) {
      setProblem(t("tipChange.bad"));
      return;
    }
    setBusy(row.payment_id);
    setProblem(null);
    setNotice(null);
    try {
      const answer = await api<{ status?: string; waiting_for?: { name: string } | null }>(
        "POST",
        `/v1/venues/${venueId}/payments/${row.payment_id}/tip`,
        { tip_cents: tip },
        { idempotencyKey: `tip-${row.payment_id}-${tip}-${Date.now()}` },
      );
      setNotice(
        answer.status === "approval_pending" && answer.waiting_for
          ? t("tipChange.waiting", { name: answer.waiting_for.name.split(" ")[0] ?? "" })
          : t("tipChange.saved", { amount: money(tip as never) }),
      );
      setTyped((prev) => ({ ...prev, [row.payment_id]: "" }));
      await load();
    } catch (err) {
      const e2 = err as ApiCallError;
      const reason = (e2?.details as { reason?: string } | undefined)?.reason;
      setProblem(
        reason === "photo_required"
          ? t("tipChange.photo")
          : reason && REFUSALS.includes(reason as Refusal)
            ? why(reason)
            : t("tipChange.failed"),
      );
    } finally {
      setBusy(null);
    }
  };

  const labelOf = (r: TipRow) =>
    r.change === "held"
      ? t("tipChange.held")
      : r.method === "outside_card"
        ? t("tipChange.outside")
        : r.method === "cash"
          ? t("tipChange.cash")
          : t("tipChange.card");

  return (
    <div className="sheet tip-change-sheet" role="dialog" aria-label={t("tipChange.title")}>
      <h2>{t("tipChange.title")}</h2>
      <p className="small muted">{t("tipChange.hint")}</p>
      {rows === null && !problem && <p role="status">{t("tipChange.loading")}</p>}
      {rows !== null && rows.length === 0 && <p>{t("tipChange.none")}</p>}
      {rows?.map((r) => (
        <form
          key={r.payment_id}
          className="tip-change-row"
          onSubmit={(e) => void save(e, r)}
          data-payment={r.payment_id}
        >
          <p>
            <strong>{labelOf(r)}</strong>
            {r.label && (
              <span className="small muted" data-guest-text>
                {" "}
                · {r.label}
              </span>
            )}
            <br />
            <span className="small">
              {t("tipChange.paid", {
                amount: money(r.amount_cents as never),
                tip: money(r.tip_cents as never),
              })}
            </span>
          </p>
          {r.waiting_for ? (
            <p className="small" role="status">
              {t("tipChange.waiting", { name: r.waiting_for.split(" ")[0] ?? "" })}
            </p>
          ) : r.change ? (
            <div className="actions">
              <label>
                <span>{t("tipChange.field")}</span>
                <input
                  inputMode="decimal"
                  value={typed[r.payment_id] ?? ""}
                  onChange={(e) =>
                    setTyped((prev) => ({ ...prev, [r.payment_id]: e.target.value }))
                  }
                />
              </label>
              <button
                type="submit"
                className="primary"
                disabled={busy !== null || !(typed[r.payment_id] ?? "").trim()}
              >
                {t("tipChange.save")}
              </button>
            </div>
          ) : (
            <p className="small muted">{why(r.refused)}</p>
          )}
        </form>
      ))}
      {notice && (
        <p className="small" role="status">
          {notice}
        </p>
      )}
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      <button type="button" className="secondary" onClick={onClose}>
        {t("tipChange.close")}
      </button>
    </div>
  );
}
