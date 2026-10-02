import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, stepUpToken, type ApiCallError } from "../api.js";
import { useT } from "../i18n.js";

/**
 * Refund from check (M4-21, M4-22; Payment flows · Refunds; screens N22):
 * pick the lines, then how much comes off which payment, then a reason, then
 * "Send to Abhishek", the button naming the approver. It starts empty, never
 * pre-filled. Then "Waiting for Abhishek", "Refund pending" and "Refunded", or
 * back with Stripe's reason. Owners and managers only.
 */
interface Refundable {
  readonly target: { kind: "check" | "booking"; id: string; label: string | null };
  readonly lines: readonly { id: number; description: string; qty: number; amount_cents: number }[];
  readonly payments: readonly {
    payment_id: string;
    method: string;
    label: string | null;
    max_refundable_cents: number;
  }[];
}
interface RefundState {
  readonly state: "waiting_approval" | "pending" | "succeeded" | "failed" | "canceled";
  readonly waiting_for: string | null;
  readonly failure_reason: string | null;
}

/** "12.34" → 1234, without a float; null if it isn't an amount. */
function toCents(raw: string): number | null {
  const m = /^\s*\$?(\d{1,6})(?:\.(\d{1,2}))?\s*$/.exec(raw);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

export function RefundSheet({
  venueId,
  checkId,
  bookingId,
  onClose,
}: {
  venueId: string;
  checkId?: string | null;
  bookingId?: string | null;
  onClose: () => void;
}) {
  const { t, money } = useT();
  const [data, setData] = useState<Refundable | null>(null);
  const [approver, setApprover] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<number, string>>({});
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [refundId, setRefundId] = useState<string | null>(null);
  const [state, setState] = useState<RefundState | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    const query = checkId ? `check=${checkId}` : `booking=${bookingId}`;
    void Promise.all([
      api<Refundable>("GET", `/v1/venues/${venueId}/refundable?${query}`),
      api<{ name: string }>("GET", `/v1/venues/${venueId}/approvals/approver`),
    ])
      .then(([d, a]) => {
        setData(d);
        setApprover(a.name.split(" ")[0] ?? a.name);
      })
      .catch(() => setProblem(t("refund.error")));
  }, [venueId, checkId, bookingId, t]);
  useEffect(() => () => clearInterval(timer.current), []);

  const follow = (id: string) => {
    const read = () =>
      void api<RefundState>("GET", `/v1/venues/${venueId}/refunds/${id}`)
        .then((s) => {
          setState(s);
          if (["succeeded", "failed", "canceled"].includes(s.state)) clearInterval(timer.current);
        })
        .catch(() => undefined);
    read();
    timer.current = setInterval(read, 2000);
  };

  const parts = (data?.payments ?? [])
    .map((p) => ({ payment_id: p.payment_id, amount_cents: toCents(amounts[p.payment_id] ?? "") }))
    .filter((p): p is { payment_id: string; amount_cents: number } => (p.amount_cents ?? 0) > 0);
  const lines = Object.entries(picked)
    .map(([id, v]) => ({ line_id: Number(id), amount_cents: toCents(v) }))
    .filter((l): l is { line_id: number; amount_cents: number } => (l.amount_cents ?? 0) > 0);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!data) return;
    setBusy(true);
    setProblem(null);
    try {
      const stepUp = await stepUpToken();
      const path =
        data.target.kind === "check"
          ? `/v1/venues/${venueId}/checks/${data.target.id}/refunds`
          : `/v1/venues/${venueId}/bookings/${data.target.id}/refunds`;
      const answer = await api<{ refund_ids: string[] }>(
        "POST",
        path,
        {
          ...(data.target.kind === "check" && lines.length > 0 ? { lines } : {}),
          parts,
          reason: reason.trim(),
        },
        { stepUp, idempotencyKey: `refund-${Date.now()}` },
      );
      const id = answer.refund_ids[0]!;
      setRefundId(id);
      follow(id);
    } catch (err) {
      const e2 = err as ApiCallError;
      const max = (e2?.details as { max_refundable_cents?: number } | undefined)
        ?.max_refundable_cents;
      setProblem(
        e2?.code === "over_refundable" && max !== undefined
          ? t("refund.over", { amount: money(max as never) })
          : t("refund.error"),
      );
    } finally {
      setBusy(false);
    }
  };

  const title =
    data?.target.kind === "booking"
      ? t("refund.titleDeposit")
      : t("refund.title", { check: data?.target.label ?? "" });
  return (
    <div className="sheet refund-sheet" role="dialog" aria-label={title}>
      <h2>{title}</h2>
      {!data && !problem && <p role="status">{t("shell.loading")}</p>}
      {data && !refundId && (
        <form onSubmit={(e) => void send(e)}>
          {data.lines.length > 0 && (
            <fieldset>
              <legend>{t("refund.lines")}</legend>
              {data.lines.map((l) => (
                <div key={l.id} className="refund-line">
                  <label>
                    <input
                      type="checkbox"
                      checked={l.id in picked}
                      onChange={(e) =>
                        setPicked((prev) => {
                          const next = { ...prev };
                          if (e.target.checked) next[l.id] = "";
                          else delete next[l.id];
                          return next;
                        })
                      }
                    />
                    <span>
                      {l.qty > 1 ? `${l.qty} × ${l.description}` : l.description} ·{" "}
                      {money(l.amount_cents as never)}
                    </span>
                  </label>
                  {l.id in picked && (
                    <input
                      inputMode="decimal"
                      aria-label={t("refund.lineAmount", { line: l.description })}
                      value={picked[l.id]}
                      onChange={(e) => setPicked((prev) => ({ ...prev, [l.id]: e.target.value }))}
                    />
                  )}
                </div>
              ))}
            </fieldset>
          )}
          <fieldset>
            <legend>{t("refund.payments")}</legend>
            {data.payments.map((p) => (
              <label key={p.payment_id}>
                <span>
                  {t("refund.upTo", {
                    label: p.label ?? (p.method === "cash" ? t("refund.cash") : t("refund.card")),
                    amount: money(p.max_refundable_cents as never),
                  })}
                </span>
                <input
                  inputMode="decimal"
                  value={amounts[p.payment_id] ?? ""}
                  onChange={(e) =>
                    setAmounts((prev) => ({ ...prev, [p.payment_id]: e.target.value }))
                  }
                />
              </label>
            ))}
          </fieldset>
          <label>
            <span>{t("refund.reason")}</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </label>
          <div className="actions">
            <button
              type="submit"
              className="primary"
              disabled={busy || parts.length === 0 || !reason.trim() || !approver}
            >
              {t("refund.send", { name: approver ?? "" })}
            </button>
            <button type="button" className="secondary" onClick={onClose}>
              {t("refund.close")}
            </button>
          </div>
        </form>
      )}
      {refundId && (
        <>
          <p role="status">
            {!state || state.state === "waiting_approval"
              ? t("approvals.waitingFor", {
                  name: (state?.waiting_for ?? approver ?? "").split(" ")[0] ?? "",
                })
              : state.state === "pending"
                ? t("refund.pending")
                : state.state === "succeeded"
                  ? t("refund.done")
                  : state.state === "failed"
                    ? t("refund.failed", { reason: state.failure_reason ?? "" })
                    : t("refund.declined")}
          </p>
          <button type="button" className="secondary" onClick={onClose}>
            {t("refund.close")}
          </button>
        </>
      )}
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
