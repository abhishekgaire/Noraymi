import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type ApiCallError } from "../api.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";

/**
 * The fix panel (M3-19; spec 10 · Changing a sent drink; Money rules 7): one
 * panel on every screen that changes a sent line (DeskRoom, the Room phone,
 * and the bar POS in M6). Comp or void, made or not, a reason, and "$X left
 * this shift" counted across every screen. Within the reason-only limit the
 * COMP or VOID line goes on at once; over it, the line reads "Waiting for
 * Andy" until he decides on his own phone.
 */
export interface FixLine {
  readonly id: number;
  readonly kind: string;
  readonly description: string;
  readonly qty: number;
  readonly amount_cents: number;
  readonly reverses_id?: number | null;
}
export interface PendingFix {
  readonly line_id: number;
  readonly kind: string;
  readonly waiting_for: string;
}

const FIXABLE = new Set(["item", "song", "damage", "fee"]);

export function FixPanel(props: {
  venueId: string;
  checkId: string;
  lines: readonly FixLine[];
  pending: readonly PendingFix[];
  onDone: () => void;
}) {
  const { t, money } = useT();
  const { subscribe } = useEvents();
  const [leftCents, setLeftCents] = useState<number | null>(null);
  const [open, setOpen] = useState<FixLine | null>(null);
  const [kind, setKind] = useState<"comp" | "void">("comp");
  const [made, setMade] = useState(true);
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadLeft = useCallback(async () => {
    try {
      setLeftCents(
        (await api<{ left_cents: number }>("GET", `/v1/venues/${props.venueId}/reason-only`))
          .left_cents,
      );
    } catch {
      setLeftCents(null);
    }
  }, [props.venueId]);
  useEffect(() => void loadLeft(), [loadLeft]);
  useEffect(
    () =>
      subscribe((events) => {
        if (
          events.length === 0 ||
          events.some((e) => e.type === "check.updated" || e.type.startsWith("approval."))
        )
          void loadLeft();
      }),
    [subscribe, loadLeft],
  );

  const reversed = (id: number) =>
    props.lines.filter((l) => l.reverses_id === id).reduce((n, l) => n + l.qty, 0);
  const fixable = props.lines.filter(
    (l) => FIXABLE.has(l.kind) && l.amount_cents > 0 && reversed(l.id) < l.qty,
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!open) return;
    setError(null);
    try {
      const answer = await api<{ status: string; waiting_for?: { name: string } }>(
        "POST",
        `/v1/venues/${props.venueId}/checks/${props.checkId}/lines/${open.id}/${kind}`,
        { reason: reason.trim(), made, ...(open.qty > 1 ? { qty } : {}) },
      );
      setMessage(
        answer.status === "added"
          ? t(kind === "void" ? "fix.voided" : "fix.comped", { line: open.description })
          : t("fix.waiting", { name: answer.waiting_for?.name ?? "" }),
      );
      setOpen(null);
      setReason("");
      await loadLeft();
      props.onDone();
    } catch (err) {
      setError((err as ApiCallError)?.message ?? t("fix.failed"));
    }
  };

  return (
    <section className="fix-panel" aria-label={t("fix.title")}>
      <h3>{t("fix.title")}</h3>
      {leftCents !== null && (
        <p className="small">{t("fix.left", { amount: money(leftCents as never) })}</p>
      )}
      {message && (
        <p className="small" role="status">
          {message}
        </p>
      )}
      <ul className="fix-lines">
        {fixable.map((l) => {
          const waiting = props.pending.find((p) => p.line_id === l.id);
          return (
            <li key={l.id}>
              <span data-guest-text>
                {l.qty > 1 ? `${l.qty} × ${l.description}` : l.description}
              </span>{" "}
              {waiting ? (
                <span className="muted">{t("fix.waiting", { name: waiting.waiting_for })}</span>
              ) : (
                <button
                  type="button"
                  className="secondary"
                  aria-label={`${t("fix.open")} · ${l.description}`}
                  onClick={() => {
                    setOpen(open?.id === l.id ? null : l);
                    setKind("comp");
                    setMade(true);
                    setQty(l.qty - reversed(l.id));
                    setReason("");
                  }}
                >
                  {t("fix.open")}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {open && (
        <form className="invite-form" onSubmit={(e) => void submit(e)}>
          <fieldset className="day-picks">
            <legend>{open.description}</legend>
            <label className="switch-line">
              <input
                type="radio"
                name="fix-kind"
                checked={kind === "comp"}
                onChange={() => setKind("comp")}
              />
              <span>{t("fix.comp")}</span>
            </label>
            <label className="switch-line">
              <input
                type="radio"
                name="fix-kind"
                checked={kind === "void"}
                onChange={() => setKind("void")}
              />
              <span>{t("fix.void")}</span>
            </label>
          </fieldset>
          <fieldset className="day-picks">
            <legend>{t("fix.made")}</legend>
            <label className="switch-line">
              <input type="radio" name="fix-made" checked={made} onChange={() => setMade(true)} />
              <span>{t("fix.made.yes")}</span>
            </label>
            <label className="switch-line">
              <input type="radio" name="fix-made" checked={!made} onChange={() => setMade(false)} />
              <span>{t("fix.made.no")}</span>
            </label>
          </fieldset>
          <div className="invite-fields">
            {open.qty > 1 && (
              <label>
                <span>{t("fix.qty")}</span>
                <input
                  type="number"
                  min={1}
                  max={open.qty - reversed(open.id)}
                  value={qty}
                  onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
                />
              </label>
            )}
            <label>
              <span>{t("fix.reason")}</span>
              <input
                value={reason}
                required
                maxLength={300}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="primary" disabled={!reason.trim()}>
            {kind === "void" ? t("fix.void.send") : t("fix.comp.send")}
          </button>
        </form>
      )}
    </section>
  );
}
