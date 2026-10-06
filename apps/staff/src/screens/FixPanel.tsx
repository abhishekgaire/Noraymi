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
 *
 * Void a drink rung by mistake in 4 taps (spec 10, timed tasks): the line, Not
 * made, a reason, VOID. The reason chips fill the reason in one tap; the
 * buttons are labelled VOID and COMP. On the bar POS (M6-15) the tab's own
 * lines are the taps: `pick`/`onPick` open the panel for a line from outside.
 */
export interface FixLine {
  readonly id: number;
  readonly kind: string;
  readonly description: string;
  readonly qty: number;
  readonly amount_cents: number;
  readonly reverses_id?: number | null;
  /** Whether it's alcohol, so Move greys out cut-off tabs for it (M6-13). */
  readonly alcohol?: boolean;
}
/** Another open tab a line can move onto (the bar POS, M6-13). */
export interface MoveTarget {
  readonly id: string;
  readonly name: string;
  readonly cut_off: { readonly by: string | null } | null;
}
export interface PendingFix {
  readonly line_id: number;
  readonly kind: string;
  readonly waiting_for: string;
}

const FIXABLE = new Set(["item", "song", "damage", "fee", "transfer_in"]);
const REASONS = ["fix.reason.rang", "fix.reason.changed", "fix.reason.spilled"] as const;

/** Whether a sent line can still be comped, voided or moved: some of it isn't reversed yet. */
export function isFixable(line: FixLine, lines: readonly FixLine[]): boolean {
  const reversed = lines.filter((l) => l.reverses_id === line.id).reduce((n, l) => n + l.qty, 0);
  return FIXABLE.has(line.kind) && line.amount_cents > 0 && reversed < line.qty;
}

export function FixPanel(props: {
  venueId: string;
  checkId: string;
  lines: readonly FixLine[];
  pending: readonly PendingFix[];
  /** The bar POS: Move a line onto another open tab, no approval (M6-13). */
  moveTabs?: readonly MoveTarget[];
  /** The bar POS lists the tab's lines itself: the line tapped there, and how to pick another. */
  pick?: number | null;
  onPick?: (lineId: number | null) => void;
  onDone: () => void;
}) {
  const { t, money } = useT();
  const { subscribe } = useEvents();
  const [leftCents, setLeftCents] = useState<number | null>(null);
  const [ownOpen, setOwnOpen] = useState<FixLine | null>(null);
  const controlled = props.onPick !== undefined;
  const open = controlled
    ? (props.lines.find((l) => l.id === props.pick && isFixable(l, props.lines)) ?? null)
    : ownOpen;
  const setOpen = (l: FixLine | null) =>
    controlled ? props.onPick!(l ? l.id : null) : setOwnOpen(l);
  const [moving, setMoving] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
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
  const fixable = props.lines.filter((l) => isFixable(l, props.lines));
  // A line picked from outside starts fresh: made, the whole of what's left, no reason.
  const openId = open?.id ?? null;
  // Reset while rendering (not in an effect), so nothing typed right after the tap is overwritten.
  const [seen, setSeen] = useState<number | null>(null);
  if (openId !== seen) {
    setSeen(openId);
    if (openId !== null) {
      const l = props.lines.find((x) => x.id === openId);
      setMoving(false);
      setTarget(null);
      setMade(true);
      setQty(l ? l.qty - reversed(l.id) : 1);
      setReason("");
      setError(null);
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (moving) void move();
  };
  const fix = async (kind: "comp" | "void") => {
    if (!open || !reason.trim()) return;
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

  // Move (M6-13): onto another open tab, no approval; both tabs log it.
  const move = async () => {
    if (!open || !target) return;
    const to = props.moveTabs?.find((x) => x.id === target);
    try {
      const answer = await api<{ status: string; waiting_for?: { name: string } }>(
        "POST",
        `/v1/venues/${props.venueId}/checks/${props.checkId}/lines/${open.id}/move`,
        { tab_id: target, ...(open.qty > 1 ? { qty } : {}) },
      );
      setMessage(
        answer.status === "moved"
          ? t("moveTab.movedToTab", { name: to?.name ?? "" })
          : t("fix.waiting", { name: answer.waiting_for?.name ?? "" }),
      );
      setOpen(null);
      setTarget(null);
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
      {!controlled && (
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
                    onClick={() => setOpen(open?.id === l.id ? null : l)}
                  >
                    {t("fix.open")}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {open && (
        <form className="invite-form" onSubmit={(e) => void submit(e)}>
          <p className="fix-line">
            <strong data-guest-text>
              {open.qty > 1 ? `${open.qty} × ${open.description}` : open.description}
            </strong>
          </p>
          {moving && props.moveTabs && (
            <fieldset className="day-picks move-targets">
              <legend>{t("fix.move.to")}</legend>
              {props.moveTabs.length === 0 && <p className="muted">{t("fix.move.none")}</p>}
              {props.moveTabs.map((x) => {
                // A cut-off tab is greyed out for alcohol, with the reason (Rail note 8).
                const refused = !!(open.alcohol && x.cut_off);
                return (
                  <label key={x.id} className={refused ? "switch-line muted" : "switch-line"}>
                    <input
                      type="radio"
                      name="fix-target"
                      disabled={refused}
                      checked={target === x.id}
                      onChange={() => setTarget(x.id)}
                    />
                    <span data-guest-text>{x.name}</span>
                    {refused && (
                      <span className="small">
                        {x.cut_off?.by
                          ? t("fix.move.cutOff", { name: x.cut_off.by })
                          : t("fix.move.cutOffNoName")}
                      </span>
                    )}
                  </label>
                );
              })}
            </fieldset>
          )}
          {!moving && (
            <fieldset className="day-picks">
              <legend>{t("fix.made")}</legend>
              <label className="switch-line">
                <input type="radio" name="fix-made" checked={made} onChange={() => setMade(true)} />
                <span>{t("fix.made.yes")}</span>
              </label>
              <label className="switch-line">
                <input
                  type="radio"
                  name="fix-made"
                  checked={!made}
                  onChange={() => setMade(false)}
                />
                <span>{t("fix.made.no")}</span>
              </label>
            </fieldset>
          )}
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
            {!moving && (
              <label>
                <span>{t("fix.reason")}</span>
                <input
                  value={reason}
                  required
                  maxLength={300}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
            )}
          </div>
          {!moving && (
            <div className="chips" role="group" aria-label={t("fix.reasons")}>
              {REASONS.map((k) => (
                <button
                  key={k}
                  type="button"
                  className="secondary"
                  aria-pressed={reason === t(k)}
                  onClick={() => setReason(t(k))}
                >
                  {t(k)}
                </button>
              ))}
            </div>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {moving ? (
            <div className="actions">
              <button type="submit" className="primary" disabled={!target}>
                {t("fix.move.send")}
              </button>
              <button type="button" className="secondary" onClick={() => setMoving(false)}>
                {t("fix.move.back")}
              </button>
            </div>
          ) : (
            <div className="actions">
              <button
                type="button"
                className="primary"
                disabled={!reason.trim()}
                onClick={() => void fix("void")}
              >
                {t("fix.void")}
              </button>
              <button
                type="button"
                className="primary"
                disabled={!reason.trim()}
                onClick={() => void fix("comp")}
              >
                {t("fix.comp")}
              </button>
              {props.moveTabs && (
                <button type="button" className="secondary" onClick={() => setMoving(true)}>
                  {t("fix.move")}
                </button>
              )}
            </div>
          )}
        </form>
      )}
    </section>
  );
}
