import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ApiCallError } from "../api.js";
import { useT } from "../i18n.js";

/**
 * Close a tab to its held card (M6-08; Staff screens and the bar POS · Paying
 * at the bar: Close to the held card, Receipt; Payment flows step 5): Close
 * tab, then Close to the card, and the guest picks the tip on the bar reader
 * (the venue's three choices, Custom and No tip); the capture includes it.
 * Every card state shows in words: waiting on the bar reader (Cancel),
 * "Checking with Stripe · don't retry", "Reader offline", "Reader busy". An
 * offline reader, or a tip screen nobody touched for 2 minutes, offers the
 * slip. Paid, the receipt: Text (the guest types their number on the reader),
 * Print or No receipt.
 */
interface Reader {
  readonly id: string;
  readonly station: string;
  readonly registered: boolean;
}
interface Closing {
  readonly id: string;
  readonly state:
    | "asking"
    | "custom"
    | "raising"
    | "capturing"
    | "captured"
    | "canceled"
    | "timed_out"
    | "failed";
  readonly tab_state: string;
  readonly balance_cents: number;
  readonly gratuity_cents: number;
  readonly tip_choices: { readonly kind: string; readonly choices_cents: number[] } | null;
  readonly tip_cents: number | null;
  readonly capture_cents: number | null;
  readonly payment: { readonly unknown: boolean };
  readonly receipt: "text" | "print" | "none" | null;
  readonly receipt_sent: boolean;
}
type Problem = "offline" | "busy" | "cardFee" | "failed" | null;

const newKey = () => `close-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export function CloseTab({
  venueId,
  tabId,
  card,
  totalCents,
  resume,
  onClose,
  onChanged,
}: {
  venueId: string;
  tabId: string;
  card: string | null;
  totalCents: number;
  /** The tab is already closing (`tipping`): pick up where it is. */
  resume: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t, money } = useT();
  const [closing, setClosing] = useState<Closing | null>(null);
  const [problem, setProblem] = useState<Problem>(null);
  const [slipped, setSlipped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const base = `/v1/venues/${venueId}/tabs/${tabId}/close`;

  const waiting = (c: Closing) =>
    ["asking", "custom", "raising", "capturing"].includes(c.state) ||
    (c.receipt === "text" && !c.receipt_sent);
  const poll = useCallback(() => {
    clearInterval(timer.current);
    // check-status reads the bar reader and Stripe now; the tip screen answers within a second.
    timer.current = setInterval(() => {
      void api<Closing>("POST", `${base}/check-status`)
        .then((c) => {
          setClosing(c);
          if (!waiting(c)) {
            clearInterval(timer.current);
            onChanged();
          }
        })
        .catch(() => undefined);
    }, 1000);
  }, [base, onChanged]);
  useEffect(() => () => clearInterval(timer.current), []);
  useEffect(() => {
    if (!resume) return;
    void api<Closing>("GET", base)
      .then((c) => {
        setClosing(c);
        if (waiting(c)) poll();
      })
      .catch(() => undefined);
  }, [resume, base, poll]);

  const run = async (call: () => Promise<Closing | null>) => {
    setBusy(true);
    setProblem(null);
    try {
      const c = await call();
      if (c) {
        setClosing(c);
        if (waiting(c)) poll();
      }
      onChanged();
    } catch (e) {
      const err = e as ApiCallError;
      const reason = (err?.details as { reason?: string } | undefined)?.reason;
      if (err?.code === "reader_offline") setProblem("offline");
      else if (err?.code === "reader_busy") setProblem("busy");
      else if (reason === "card_fee_fresh_tap") setProblem("cardFee");
      else setProblem("failed");
    } finally {
      setBusy(false);
    }
  };
  const barReader = async () => {
    const list = await api<{ readers: Reader[] }>("GET", `/v1/venues/${venueId}/readers`);
    const ready = list.readers.filter((r) => r.registered);
    return (ready.find((r) => r.station === "bar") ?? ready[0])?.id ?? null;
  };
  const toCard = () =>
    run(async () =>
      api<Closing>(
        "POST",
        base,
        { tip: "reader", reader_id: await barReader() },
        { idempotencyKey: newKey() },
      ),
    );
  const slip = () =>
    run(async () => {
      await api("POST", base, { tip: "slip" }, { idempotencyKey: newKey() });
      setSlipped(true);
      return null;
    });
  const cancel = () =>
    run(() => api<Closing>("POST", `${base}/cancel`, undefined, { idempotencyKey: newKey() }));
  const receipt = (choice: "text" | "print" | "none") =>
    run(async () => {
      const c = await api<Closing>(
        "POST",
        `${base}/receipt`,
        { choice },
        { idempotencyKey: newKey() },
      );
      if (choice !== "text") setDone(true);
      return c;
    });

  const state = closing?.state ?? null;
  const asking = closing !== null && (state === "asking" || state === "custom");
  const charging = closing !== null && (state === "raising" || state === "capturing");
  const backToOpen = state === "canceled" || state === "timed_out";

  return (
    <section className="close-tab" aria-label={t("closeTab.title")}>
      <h3>{t("closeTab.title")}</h3>
      <p className="total">
        {t("rail.total")} <strong>{money((closing?.balance_cents ?? totalCents) as never)}</strong>
      </p>
      {closing && closing.gratuity_cents > 0 && <p className="small">{t("closeOut.gratuity")}</p>}

      {!closing && !slipped && (
        <div className="actions">
          <button type="button" className="primary" disabled={busy} onClick={() => void toCard()}>
            {t("closeTab.toCard")}
            {card ? (
              <>
                {" · "}
                <span data-guest-text>{card}</span>
              </>
            ) : null}
          </button>
          <button type="button" className="link" onClick={onClose}>
            {t("closeTab.back")}
          </button>
        </div>
      )}

      {asking && (
        <div role="status">
          <p>{state === "custom" ? t("closeTab.custom") : t("closeTab.waiting")}</p>
          {state === "asking" && closing.tip_choices && (
            <ul className="tip-choices" aria-label={t("closeTab.choices")}>
              {closing.tip_choices.choices_cents.map((c, i) => (
                <li key={i}>{money(c as never)}</li>
              ))}
              <li>{t("closeTab.customChoice")}</li>
              <li>{t("closeTab.noTip")}</li>
            </ul>
          )}
          <button type="button" className="secondary" disabled={busy} onClick={() => void cancel()}>
            {t("pay.cancel")}
          </button>
        </div>
      )}
      {charging && (
        <p role="status" className={closing.payment.unknown ? "warn" : undefined}>
          {closing.payment.unknown ? t("pay.unknown") : t("closeTab.charging")}
        </p>
      )}
      {state === "failed" && (
        <p className="error" role="alert">
          {t("closeTab.failed")}
        </p>
      )}
      {backToOpen && (
        <div role="status">
          <p>{state === "timed_out" ? t("closeTab.noAnswer") : t("closeTab.canceled")}</p>
          <div className="actions">
            <button type="button" className="primary" disabled={busy} onClick={() => void slip()}>
              {t("closeTab.slip")}
            </button>
            <button type="button" className="link" onClick={onClose}>
              {t("closeTab.back")}
            </button>
          </div>
        </div>
      )}

      {closing && state === "captured" && (
        <div>
          <p className="notice" role="status">
            {t("closeTab.paid", {
              amount: money((closing.capture_cents ?? 0) as never),
              tip: money((closing.tip_cents ?? 0) as never),
            })}
          </p>
          {done || (closing.receipt === "text" && closing.receipt_sent) ? (
            <button type="button" className="primary" onClick={onClose}>
              {t("closeTab.done")}
            </button>
          ) : closing.receipt === "text" ? (
            <p role="status">{t("closeTab.typeNumber")}</p>
          ) : (
            <div className="actions" aria-label={t("closeOut.receipt")}>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void receipt("text")}
              >
                {t("closeOut.text")}
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void receipt("print")}
              >
                {t("closeOut.print")}
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void receipt("none")}
              >
                {t("closeOut.none")}
              </button>
            </div>
          )}
        </div>
      )}

      {slipped && (
        <div role="status">
          <p>{t("closeTab.slipped")}</p>
          <button type="button" className="primary" onClick={onClose}>
            {t("closeTab.done")}
          </button>
        </div>
      )}

      {problem === "offline" && !slipped && (
        <div role="alert">
          <p className="error">{t("closeTab.offline")}</p>
          <button type="button" className="primary" disabled={busy} onClick={() => void slip()}>
            {t("closeTab.slip")}
          </button>
        </div>
      )}
      {problem === "busy" && (
        <p className="error" role="alert">
          {t("pay.busy")}
        </p>
      )}
      {problem === "cardFee" && (
        <p className="error" role="alert">
          {t("closeTab.cardFee")}
        </p>
      )}
      {problem === "failed" && (
        <p className="error" role="alert">
          {t("closeTab.error")}
        </p>
      )}
    </section>
  );
}
