import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ApiCallError } from "../api.js";
import { useT } from "../i18n.js";
import { CashPanel, CashResult, type Taken } from "./CashPanel.js";
import { ReceiptStep } from "./ReceiptStep.js";
import { TapPayment } from "./TapPayment.js";
import { SavedCard } from "./SavedCard.js";

/**
 * Close a tab to its held card (M6-08; Staff screens and the bar POS · Paying
 * at the bar: Close to the held card, Receipt; Payment flows step 5): Close
 * tab, then Close to the card, and the guest picks the tip on the bar reader
 * (the venue's three choices, Custom and No tip); the capture includes it.
 * Every card state shows in words: waiting on the bar reader (Cancel),
 * "Checking with Stripe · don't retry", "Reader offline", "Reader busy". An
 * offline reader offers the slip; a tip screen nobody touched for 2 minutes,
 * or a venue whose bar tabs tip on paper, prints it (M6-09), and the tip is
 * entered later from Tips to enter. Paid, the receipt: Text (the guest types their number on the reader),
 * Print or No receipt. Another card (the tip on the reader) or Cash pays the balance instead (M6-11): the
 * hold is released once that payment has succeeded, and a declined card leaves it standing.
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
    | "failed"
    | "slip";
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
  checkId,
  card,
  totalCents,
  resume,
  noHold = false,
  savedCard = null,
  onClose,
  onChanged,
}: {
  venueId: string;
  tabId: string;
  checkId: string;
  card: string | null;
  totalCents: number;
  /** The tab is already closing (`tipping`): pick up where it is. */
  resume: boolean;
  /** A reopened tab whose hold was captured (M6-12): no "Close to the card". */
  noHold?: boolean;
  /** The card saved from its first tap, and a charge on it already waiting. */
  savedCard?: { card: string; paymentId: string | null } | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t, money } = useT();
  const [closing, setClosing] = useState<Closing | null>(null);
  const [problem, setProblem] = useState<Problem>(null);
  const [slipped, setSlipped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  // Another card or cash (M6-11), or the saved card on a reopened tab (M6-12), and what it paid.
  const [other, setOther] = useState<"card" | "cash" | "saved" | null>(
    savedCard?.paymentId ? "saved" : null,
  );
  const [paidOther, setPaidOther] = useState<Taken | "card" | "saved" | null>(null);
  const payUrl = `/v1/venues/${venueId}/tabs/${tabId}/pay`;
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
      const c = await api<Closing>("POST", base, { tip: "slip" }, { idempotencyKey: newKey() });
      setSlipped(true);
      return c;
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

      {paidOther && (
        <>
          {paidOther !== "card" && paidOther !== "saved" && (
            <CashResult venueId={venueId} taken={paidOther} />
          )}
          <p role="status">{noHold ? t("pay.paid") : t("closeTab.released")}</p>
          <ReceiptStep
            venueId={venueId}
            checkId={checkId}
            roomName=""
            doneText={t("closeTab.closed")}
          />
          <button type="button" className="primary" onClick={onClose}>
            {t("closeTab.done")}
          </button>
        </>
      )}
      {other && !paidOther && (
        <>
          {other === "saved" && savedCard ? (
            <SavedCard
              venueId={venueId}
              tabId={tabId}
              card={savedCard.card}
              dueCents={totalCents}
              paymentId={savedCard.paymentId}
              onPaid={() => setPaidOther("saved")}
              onChanged={onChanged}
            />
          ) : other === "card" ? (
            <TapPayment
              venueId={venueId}
              checkId={checkId}
              dueCents={totalCents}
              payUrl={payUrl}
              onDone={() => {
                setPaidOther("card");
                onChanged();
              }}
            />
          ) : (
            <CashPanel
              venueId={venueId}
              checkId={checkId}
              dueCents={totalCents}
              payUrl={payUrl}
              oneTap
              onTaken={(taken) => {
                setPaidOther(taken);
                onChanged();
              }}
            />
          )}
          <button type="button" className="link" onClick={() => setOther(null)}>
            {t("closeTab.otherWays")}
          </button>
        </>
      )}
      {!closing && !slipped && !other && (
        <div className="actions">
          {!noHold && (
            <button type="button" className="primary" disabled={busy} onClick={() => void toCard()}>
              {t("closeTab.toCard")}
              {card ? (
                <>
                  {" · "}
                  <span data-guest-text>{card}</span>
                </>
              ) : null}
            </button>
          )}
          {noHold && savedCard && (
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => setOther("saved")}
            >
              {t("savedCard.title")}
              {" · "}
              <span data-guest-text>{savedCard.card}</span>
            </button>
          )}
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => setOther("card")}
          >
            {t("closeTab.anotherCard")}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => setOther("cash")}
          >
            {t("cash.title")}
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

      {(slipped || state === "slip") && (
        <div role="status">
          <p>{t("closeTab.slipPrinted")}</p>
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
