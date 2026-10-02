import { useCallback, useEffect, useRef, useState } from "react";
import { cents, type MessageKey } from "@west4/shared";
import { api, type ApiCallError } from "../api.js";
import { readDevice } from "../device.js";
import { useT } from "../i18n.js";

/**
 * Tap at the reader (M4-11; Payment flows · What staff see during a card
 * payment; screens N21): pick a reader first (this screen's station first),
 * add an optional additional tip, and the card states every paying screen
 * shows: Waiting · Cancel, Paid, Declined (tap again), Checking with Stripe,
 * Reader offline (use the other reader) and Reader busy.
 */
interface Reader {
  readonly id: string;
  readonly label: string;
  readonly registered: boolean;
  readonly online: boolean;
  readonly station: "bar" | "front_desk";
}
interface Payment {
  readonly id: string;
  readonly status: string;
  readonly state:
    "waiting" | "paid" | "authorized" | "declined" | "unknown" | "canceled" | "failed";
  readonly amount_cents: number;
  readonly tip_cents: number;
  readonly reader: { readonly id: string; readonly station: string } | null;
}
type Problem = { kind: "offline" | "busy"; station: string } | { kind: "failed" } | null;

const newKey = () => `tap-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
/** The payment out of a 2xx answer, or out of 202 payment_unknown's details. */
const paymentOf = (body: unknown): Payment =>
  (body as { error?: { details?: { payment?: Payment } } }).error?.details?.payment ??
  (body as Payment);

export function TapPayment({
  venueId,
  checkId,
  dueCents,
  onDone,
}: {
  venueId: string;
  checkId: string;
  dueCents: number;
  onDone: () => void;
}) {
  const { t, money } = useT();
  const [readers, setReaders] = useState<readonly Reader[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [tip, setTip] = useState("");
  const [payment, setPayment] = useState<Payment | null>(null);
  const [problem, setProblem] = useState<Problem>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    void (async () => {
      const [list, device] = await Promise.all([
        api<{ readers: Reader[] }>("GET", `/v1/venues/${venueId}/readers`),
        readDevice().catch(() => null),
      ]);
      const mine = device?.kind === "bar_computer" ? "bar" : "front_desk";
      // This screen's station first.
      setReaders(
        list.readers
          .filter((r) => r.registered)
          .sort((a, b) => Number(b.station === mine) - Number(a.station === mine)),
      );
    })().catch(() => setProblem({ kind: "failed" }));
  }, [venueId]);

  const poll = useCallback(
    (id: string) => {
      clearInterval(timer.current);
      timer.current = setInterval(() => {
        // check-status reads Stripe now, through the same state machine as the webhooks (M4-05).
        void api<Payment>("POST", `/v1/venues/${venueId}/payments/${id}/check-status`)
          .then((p) => {
            setPayment(p);
            if (p.state !== "waiting" && p.state !== "unknown") {
              clearInterval(timer.current);
              if (p.state === "paid") onDone();
            }
          })
          .catch(() => undefined);
      }, 2000);
    },
    [venueId, onDone],
  );
  useEffect(() => () => clearInterval(timer.current), []);

  const tipCents = Math.round(Number(tip || "0") * 100);
  const run = async (call: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    try {
      const p = paymentOf(await call());
      setPayment(p);
      if (p.state === "waiting" || p.state === "unknown") poll(p.id);
      if (p.state === "paid") onDone();
    } catch (e) {
      const err = e as ApiCallError;
      const station = readers.find((r) => r.id === picked)?.station ?? "front_desk";
      const p = (err?.details as { payment?: Payment } | undefined)?.payment;
      if (p) setPayment(p);
      if (err?.code === "reader_offline") setProblem({ kind: "offline", station });
      else if (err?.code === "reader_busy") setProblem({ kind: "busy", station });
      else setProblem({ kind: "failed" });
    } finally {
      setBusy(false);
    }
  };
  const start = () =>
    run(() =>
      api(
        "POST",
        `/v1/venues/${venueId}/checks/${checkId}/payments`,
        {
          method: "tap",
          amount_cents: dueCents,
          reader_id: picked,
          ...(tipCents > 0 ? { tip_cents: tipCents } : {}),
        },
        { idempotencyKey: newKey() },
      ),
    );
  const again = () =>
    run(() =>
      api(
        "POST",
        `/v1/venues/${venueId}/payments/${payment!.id}/tap`,
        { reader_id: picked },
        { idempotencyKey: newKey() },
      ),
    );
  const cancel = () =>
    run(() =>
      api("POST", `/v1/venues/${venueId}/payments/${payment!.id}/cancel`, undefined, {
        idempotencyKey: newKey(),
      }),
    );

  const other = (station: string) => (station === "bar" ? "front_desk" : "bar");
  const reading =
    payment?.reader?.station ?? readers.find((r) => r.id === picked)?.station ?? "front_desk";
  // A payment that's still pending (declined, or its reader offline or busy) is tapped again; a new one starts fresh.
  const pending =
    payment && (payment.state === "declined" || (problem && payment.status === "pending"));
  const open = !payment || payment.state === "canceled" || payment.state === "failed" || pending;

  // Nothing to pay and nothing in flight: no panel. A payment in flight keeps it, whatever is due now.
  if (dueCents <= 0 && !payment) return null;
  return (
    <section className="tap-payment" aria-label={t("pay.tap.title")}>
      <h3>{t("pay.tap.title")}</h3>
      {open && (
        <>
          <fieldset className="readers-pick">
            <legend>{t("pay.reader")}</legend>
            {readers.map((r) => (
              <label key={r.id}>
                <input
                  type="radio"
                  name="reader"
                  checked={picked === r.id}
                  onChange={() => setPicked(r.id)}
                />
                <span>{r.label}</span>
              </label>
            ))}
          </fieldset>
          {!pending && (
            <label>
              <span>{t("pay.tip")}</span>
              <input
                inputMode="decimal"
                aria-label={t("pay.tip")}
                value={tip}
                onChange={(e) => setTip(e.target.value)}
              />
            </label>
          )}
          {!picked && <p className="small muted">{t("pay.pickReader")}</p>}
          <button
            type="button"
            className="primary"
            disabled={busy || !picked || (!pending && dueCents <= 0)}
            onClick={() => void (pending ? again() : start())}
          >
            {pending
              ? t("pay.tapAgain")
              : t("pay.tapButton", { amount: money(cents(dueCents + tipCents)) })}
          </button>
        </>
      )}
      {payment?.state === "waiting" && (
        <p role="status">
          {t(`pay.waiting.${reading}` as MessageKey)}
          {" · "}
          <button type="button" className="link" disabled={busy} onClick={() => void cancel()}>
            {t("pay.cancel")}
          </button>
        </p>
      )}
      {payment?.state === "unknown" && <p role="status">{t("pay.unknown")}</p>}
      {payment?.state === "paid" && <p role="status">{t("pay.paid")}</p>}
      {payment?.state === "declined" && !problem && <p role="alert">{t("pay.declined")}</p>}
      {payment?.state === "canceled" && <p role="status">{t("pay.canceled")}</p>}
      {problem?.kind === "offline" && (
        <p role="alert">{t(`pay.offline.${other(problem.station)}` as MessageKey)}</p>
      )}
      {problem?.kind === "busy" && <p role="alert">{t("pay.busy")}</p>}
      {problem?.kind === "failed" && (
        <p className="error" role="alert">
          {t("pay.failed")}
        </p>
      )}
    </section>
  );
}
