import { useEffect, useRef, useState } from "react";
import { api, ApiCallError } from "../api.js";
import { useT } from "../i18n.js";

/**
 * Food rung by staff (K-05; Kitchen and food · Ordering food; FoodBar.dc.html): the "Send to kitchen
 * (N)" button and its confirmation, the Not sent reminder, the warning before a tab or check is
 * closed or paid, and each food line's "Not sent" or "Sent · 11:42" with Delete or Reprint. The
 * parent does the sending, because a bar tab's or a quick sale's round goes on first.
 */
export interface KitchenLine {
  /** "d:<i>" for a line still in the draft, "c:<line id>" for a line on the check. */
  readonly key: string;
  readonly label: string;
  readonly qty: number;
  readonly note: string;
  readonly allergy: boolean;
}
export interface KitchenNotes {
  readonly notes: Readonly<Record<string, { note: string; allergy: boolean }>>;
  readonly name: string | null;
}
/** A food line as the check view gives it (K-05). */
export interface CheckFood {
  readonly sent_at: string | null;
  readonly sent_by: string | null;
  readonly rung_at: string;
  readonly open_qty: number;
  readonly kitchen_note: string | null;
  readonly allergy: boolean;
  readonly job_id: string | null;
}

/** The reminder: "2 food items not sent to the kitchen", amber, once food has waited unsentWarnMin. */
export function UnsentReminder({ count }: { count: number }) {
  const { tn } = useT();
  if (count <= 0) return null;
  return (
    <p className="kitchen-reminder" role="status">
      {tn("kitchen.unsent", count)}
    </p>
  );
}

/** Before Close or Pay: the same words, with Send to kitchen beside them; going ahead is allowed. */
export function UnsentWarning(props: {
  count: number;
  anyway: "close" | "pay";
  onSend: () => void;
  onAnyway: () => void;
  onBack: () => void;
}) {
  const { t, tn } = useT();
  return (
    <div
      className="kitchen-warning"
      role="alertdialog"
      aria-label={tn("kitchen.unsent", props.count)}
    >
      <p>
        <strong>{tn("kitchen.unsent", props.count)}</strong>
      </p>
      <div className="actions">
        <button type="button" className="primary" onClick={props.onSend}>
          {t("kitchen.send.button", { n: props.count })}
        </button>
        <button type="button" className="secondary" onClick={props.onAnyway}>
          {props.anyway === "close"
            ? t("kitchen.unsent.closeAnyway")
            : t("kitchen.unsent.payAnyway")}
        </button>
        <button type="button" className="link" onClick={props.onBack}>
          {t("kitchen.send.cancel")}
        </button>
      </div>
    </div>
  );
}

export function SendToKitchen(props: {
  lines: readonly KitchenLine[];
  /** A quick sale has no name: the confirmation asks for one first. */
  needsName: boolean;
  /** Bumped from outside (the warning before Close or Pay) to open the confirmation. */
  openRequest?: number;
  onSend: (notes: KitchenNotes) => Promise<void>;
}) {
  const { t } = useT();
  const count = props.lines.reduce((n, l) => n + l.qty, 0);
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<Record<string, { note: string; allergy: boolean }>>({});
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only a request made after this screen opened opens the confirmation.
  const seen = useRef(props.openRequest ?? 0);
  useEffect(() => {
    if (props.openRequest === undefined || props.openRequest === seen.current) return;
    seen.current = props.openRequest;
    start();
    // Only a new request opens it.
  }, [props.openRequest]);
  function start() {
    setNotes(
      Object.fromEntries(props.lines.map((l) => [l.key, { note: l.note, allergy: l.allergy }])),
    );
    setError(null);
    setOpen(true);
  }
  const send = async () => {
    if (props.needsName && !name.trim()) {
      setError(t("kitchen.send.nameNeeded"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await props.onSend({ notes, name: props.needsName ? name.trim() : null });
      setOpen(false);
      setName("");
    } catch (e) {
      const err = e as ApiCallError;
      setError(
        err?.details?.["reason"] === "already_sent"
          ? t("kitchen.send.already")
          : err?.message || t("kitchen.send.failed"),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className="primary kitchen-send" disabled={count === 0} onClick={start}>
        {t("kitchen.send.button", { n: count })}
      </button>
      {open && (
        <div className="sheet kitchen-sheet" role="dialog" aria-label={t("kitchen.send.title")}>
          <h3>{t("kitchen.send.title")}</h3>
          <p className="small muted">{t("kitchen.send.only")}</p>
          {props.needsName && (
            <label className="grow">
              <span>{t("kitchen.send.name")}</span>
              <input
                value={name}
                maxLength={40}
                placeholder={t("kitchen.send.nameHint")}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
          )}
          <ul className="kitchen-lines">
            {props.lines.map((l) => {
              const n = notes[l.key] ?? { note: "", allergy: false };
              const set = (next: Partial<typeof n>) =>
                setNotes((all) => ({ ...all, [l.key]: { ...n, ...next } }));
              return (
                <li key={l.key} className={n.allergy && n.note.trim() ? "allergy" : undefined}>
                  <span data-guest-text>{`${l.qty} × ${l.label}`}</span>
                  <input
                    aria-label={`${t("kitchen.send.note")} · ${l.label}`}
                    placeholder={t("kitchen.send.note")}
                    value={n.note}
                    maxLength={200}
                    onChange={(e) => set({ note: e.target.value })}
                  />
                  <label className="kitchen-allergy">
                    <input
                      type="checkbox"
                      checked={n.allergy}
                      onChange={(e) => set({ allergy: e.target.checked })}
                    />
                    <span>{t("kitchen.send.allergy")}</span>
                  </label>
                  {n.allergy && n.note.trim() && (
                    <span className="small kitchen-allergy-hint">
                      {t("kitchen.send.allergyHint", { note: n.note.trim().toUpperCase() })}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="actions">
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              {t("kitchen.send.cancel")}
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || count === 0}
              aria-busy={busy}
              onClick={() => void send()}
            >
              {busy ? t("kitchen.send.sending") : t("kitchen.send.button", { n: count })}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** A food line's mark on the tab or check: "Not sent" with Delete, or "Sent · 11:42" with Reprint. */
export function FoodMark(props: {
  venueId: string;
  checkId: string;
  lineId: number;
  label: string;
  food: CheckFood;
  timeZone: string;
  canRemove: boolean;
  onDone: () => void;
}) {
  const { t, time } = useT();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setSaid(null);
    try {
      await fn();
    } catch (e) {
      setSaid(e instanceof ApiCallError ? e.message : t("kitchen.send.failed"));
    } finally {
      setBusy(false);
    }
  };
  if (props.food.open_qty <= 0) return null;
  if (!props.food.sent_at)
    return (
      <span className="kitchen-mark">
        <span className="kitchen-ns">{t("kitchen.notSent")}</span>
        {props.canRemove && (
          <button
            type="button"
            className="link"
            disabled={busy}
            aria-label={t("kitchen.remove.label", { name: props.label })}
            onClick={() =>
              void run(async () => {
                await api(
                  "POST",
                  `/v1/venues/${props.venueId}/checks/${props.checkId}/lines/${props.lineId}/remove-unsent`,
                );
                props.onDone();
              })
            }
          >
            {t("kitchen.remove")}
          </button>
        )}
        {said && <span className="small error">{said}</span>}
      </span>
    );
  const jobId = props.food.job_id;
  return (
    <span className="kitchen-mark">
      <span className="kitchen-sent">
        {t("kitchen.sentAt", { time: time(props.food.sent_at, props.timeZone) })}
      </span>
      {jobId && (
        <button
          type="button"
          className="link"
          disabled={busy}
          aria-label={t("kitchen.reprint.label", { name: props.label })}
          onClick={() =>
            void run(async () => {
              const r = await api<{ reprint_n: number }>(
                "POST",
                `/v1/venues/${props.venueId}/print-jobs/${jobId}/reprint`,
                {},
              );
              setSaid(t("kitchen.reprinted", { n: r.reprint_n }));
            })
          }
        >
          {t("kitchen.reprint")}
        </button>
      )}
      {said && (
        <span className="small" role="status">
          {said}
        </span>
      )}
    </span>
  );
}
