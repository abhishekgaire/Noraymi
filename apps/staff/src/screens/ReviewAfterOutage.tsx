import { useCallback, useEffect, useState } from "react";
import type { Cents, MessageKey } from "@west4/shared";
import { api, type ApiCallError } from "../api.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";
import { dollarsToCents } from "./admin/Prices.js";

/**
 * Review after outage (M8-05; spec 09 · Review after outage; screens N29, Night note 8): on
 * Close the night, for a manager. Every order taken offline and its payment, the ones that
 * failed the replay checks first with the reason, offline cash noted on a round to post as a
 * cash payment on its check (into the drawer at this screen, with the PIN again), and the
 * break-glass card payments still waiting in Unmatched payments.
 */
interface OfflineOrder {
  readonly id: string;
  readonly order_id: string;
  readonly queued_at: string;
  readonly tab_name: string;
  readonly staff_name: string;
  readonly lines: readonly { readonly qty: number; readonly name: string }[];
  readonly total_cents: number;
  readonly cash_note: string | null;
  readonly outcome: "held" | "failed";
  readonly reason: string | null;
  readonly order_status: string | null;
  readonly check_status: string | null;
  readonly cash_posted: { amount_cents: number; at: string; by: string } | null;
}
interface Review {
  readonly orders: readonly OfflineOrder[];
  readonly unmatched: readonly { id: string }[];
  readonly pin_again: boolean;
}

const orderWords = (o: OfflineOrder): MessageKey | null => {
  if (o.outcome === "failed") return null;
  if (o.order_status === "held") return "review.order.held";
  if (o.order_status === "cancelled") return "review.order.cancelled";
  return "review.order.accepted";
};

export function ReviewAfterOutage({
  venueId,
  date,
  timeZone,
}: {
  venueId: string;
  date: string;
  timeZone: string;
}) {
  const { t, money, time } = useT();
  const { subscribe } = useEvents();
  const [review, setReview] = useState<Review | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setReview(
        await api<Review>("GET", `/v1/venues/${venueId}/offline-orders?business_date=${date}`),
      );
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [venueId, date]);
  useEffect(() => void load(), [load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (
          events.length === 0 ||
          events.some(
            (e) =>
              e.type.startsWith("order.") ||
              e.type.startsWith("offline.") ||
              e.type.startsWith("check.") ||
              e.type.startsWith("payment."),
          )
        )
          void load();
      }),
    [subscribe, load],
  );

  return (
    <section className="card review-outage" aria-labelledby="review-outage-title">
      <h2 id="review-outage-title">{t("review.title")}</h2>
      <p className="small">{t("review.hint")}</p>
      {failed && (
        <p role="alert" className="error">
          {t("review.error")}
        </p>
      )}
      {review === null ? (
        !failed && <p role="status">{t("review.loading")}</p>
      ) : (
        <>
          {review.orders.length === 0 ? (
            <p className="muted">{t("review.none")}</p>
          ) : (
            <ul className="review-outage-list">
              {review.orders.map((o) => (
                <ReviewRow
                  key={o.id}
                  order={o}
                  venueId={venueId}
                  pinAgain={review.pin_again}
                  onChanged={() => void load()}
                  words={orderWords(o)}
                  queued={t("review.queued", {
                    tab: o.tab_name,
                    name: o.staff_name,
                    time: time(o.queued_at, timeZone),
                  })}
                  what={`${o.lines.map((l) => `${l.qty} × ${l.name}`).join(", ")} · ${money(o.total_cents as Cents)}`}
                />
              ))}
            </ul>
          )}
          {review.unmatched.length > 0 && (
            <p className="notice" data-testid="review-unmatched">
              {t("review.unmatched", { count: review.unmatched.length })}{" "}
              <span className="small">{t("review.unmatchedHint")}</span>
            </p>
          )}
        </>
      )}
    </section>
  );
}

function ReviewRow({
  order: o,
  venueId,
  pinAgain,
  onChanged,
  words,
  queued,
  what,
}: {
  order: OfflineOrder;
  venueId: string;
  pinAgain: boolean;
  onChanged: () => void;
  words: MessageKey | null;
  queued: string;
  what: string;
}) {
  const { t, money } = useT();
  const [amount, setAmount] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cents = dollarsToCents(amount);

  const post = async () => {
    if (!cents) return;
    setBusy(true);
    setError(null);
    try {
      await api(
        "POST",
        `/v1/venues/${venueId}/offline-orders/${o.id}/cash`,
        { amount_cents: cents, ...(pinAgain ? { pin } : {}) },
        { idempotencyKey: `offline-cash-${o.id}-${Date.now()}` },
      );
      setAmount("");
      setPin("");
      onChanged();
    } catch (e) {
      setError((e as ApiCallError)?.message ?? t("replayed.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      className={`review-outage-row ${o.outcome}`}
      data-testid="review-row"
      data-outcome={o.outcome}
    >
      <p>
        <strong data-guest-text>{queued}</strong>
      </p>
      <p className="small" data-guest-text>
        {what}
      </p>
      {o.outcome === "failed" ? (
        <p className="badge-text">
          {t("review.failed", { reason: t(`review.reason.${o.reason}` as MessageKey) })}
        </p>
      ) : (
        words && <p className="small">{t(words)}</p>
      )}
      {o.check_status && (
        <p className="small muted">
          {o.check_status === "paid" ? t("review.check.paid") : t("review.check.open")}
        </p>
      )}
      {o.cash_note &&
        (o.cash_posted ? (
          <p className="small">
            {t("review.cash.posted", {
              amount: money(o.cash_posted.amount_cents as Cents),
              name: o.cash_posted.by,
            })}
          </p>
        ) : (
          <form
            className="invite-fields"
            onSubmit={(e) => {
              e.preventDefault();
              void post();
            }}
          >
            <p className="small" data-guest-text>
              {t("review.cash", { note: o.cash_note })}
            </p>
            <label>
              <span>{t("review.cash.amount")}</span>
              <input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
            {pinAgain && (
              <label>
                <span>{t("drawer.pin")}</span>
                <input
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                />
              </label>
            )}
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <button
              type="submit"
              className="primary"
              disabled={busy || !cents || (pinAgain && !/^\d{4,6}$/.test(pin))}
            >
              {t("review.cash.post")}
            </button>
          </form>
        ))}
    </li>
  );
}
