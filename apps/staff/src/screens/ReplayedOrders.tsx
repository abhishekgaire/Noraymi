import { useCallback, useEffect, useState } from "react";
import type { Cents, MessageKey } from "@west4/shared";
import { api, type ApiCallError } from "../api.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";

/**
 * "Confirm replayed orders (3)" (M8-05; spec 09 · Replay; screens N29): the rounds the bar
 * computer queued in the outage, replayed as asked to wait. Each stays off the tab until a
 * bartender accepts it against the tab, which is the sale; a round that was also rung online
 * during the outage is cancelled here, so it's charged once. On the bar POS and the bar orders
 * screen; nothing shows when none are waiting. A cash quick sale taken offline (U-16) that the
 * server refused shows here too, with its reason and the cash taken, until someone taps OK: the
 * cash is in the drawer, the sale isn't on the books, and a manager sees it on Review after outage.
 */
export interface RefusedCashSale {
  readonly id: string;
  readonly queued_at: string;
  readonly staff_name: string;
  readonly lines: readonly { readonly qty: number; readonly name: string }[];
  readonly cash_cents: number;
  readonly reason: string;
}

export interface ReplayedOrder {
  readonly id: string;
  readonly source: string;
  readonly status: string;
  readonly placed_at: string;
  readonly tab_name: string | null;
  readonly room_name: string | null;
  readonly queued_by: string | null;
  readonly amount_cents: number;
  readonly items: readonly { readonly qty: number; readonly name_snapshot: string }[];
}

const CHECK_MS = 15_000;

/** The replayed rounds in a list of orders: held, from the bar computer's queue. */
export const replayedOf = <T extends { source: string; status: string }>(orders: readonly T[]) =>
  orders.filter((o) => o.source === "offline" && o.status === "held");

export function ReplayedOrders({ venueId, timeZone }: { venueId: string; timeZone: string }) {
  const { t, money, time } = useT();
  const { subscribe } = useEvents();
  const [orders, setOrders] = useState<readonly ReplayedOrder[]>([]);
  const [refused, setRefused] = useState<readonly RefusedCashSale[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!venueId) return;
    try {
      const r = await api<{ orders: ReplayedOrder[] }>(
        "GET",
        `/v1/venues/${venueId}/orders?status=held`,
      );
      setOrders(replayedOf(r.orders));
      const sales = await api<{ sales: RefusedCashSale[] }>(
        "GET",
        `/v1/venues/${venueId}/offline-orders/refused`,
      ).catch(() => null);
      if (sales) setRefused(sales.sales);
    } catch {
      // The screen's own error line says when our API can't be reached.
    }
  }, [venueId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), CHECK_MS);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (
          events.length === 0 ||
          events.some((e) => e.type.startsWith("order.") || e.type.startsWith("offline."))
        )
          void load();
      }),
    [subscribe, load],
  );

  const step = async (o: ReplayedOrder, action: "accept" | "cancel") => {
    setBusy(o.id);
    setError(null);
    try {
      await api(
        "POST",
        `/v1/venues/${venueId}/orders/${o.id}/${action}`,
        action === "cancel" ? { for: "staff" } : {},
      );
    } catch (e) {
      setError((e as ApiCallError)?.message ?? t("replayed.failed"));
    } finally {
      setBusy(null);
      await load();
    }
  };

  const seen = async (sale: RefusedCashSale) => {
    setBusy(sale.id);
    setError(null);
    try {
      await api("POST", `/v1/venues/${venueId}/offline-orders/${sale.id}/seen`, {});
    } catch (e) {
      setError((e as ApiCallError)?.message ?? t("replayed.failed"));
    } finally {
      setBusy(null);
      await load();
    }
  };

  if (orders.length === 0 && refused.length === 0) return null;
  return (
    <section className="card replayed-orders" aria-labelledby="replayed-title">
      <h2 id="replayed-title">
        {t("connection.banner.replayed", { n: orders.length + refused.length })}
      </h2>
      {orders.length > 0 && <p className="small">{t("replayed.hint")}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <ul>
        {orders.map((o) => (
          <li key={o.id} className="replayed-order" data-testid="replayed-order">
            <p data-guest-text>
              <strong>
                {t("replayed.line", {
                  tab: o.tab_name ?? o.room_name ?? "",
                  what: o.items.map((i) => `${i.qty} × ${i.name_snapshot}`).join(", "),
                  total: money(o.amount_cents as Cents),
                })}
              </strong>
            </p>
            <p className="small status">
              {t("replayed.queuedBy", {
                name: o.queued_by ?? "",
                time: time(o.placed_at, timeZone),
              })}
            </p>
            <div className="team-actions">
              <button
                type="button"
                className="primary"
                disabled={busy === o.id}
                onClick={() => void step(o, "accept")}
              >
                {t("barOrders.accept")}
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy === o.id}
                onClick={() => void step(o, "cancel")}
              >
                {t("replayed.cancel")}
              </button>
            </div>
          </li>
        ))}
        {refused.map((s) => (
          <li key={s.id} className="replayed-order refused" data-testid="refused-cash-sale">
            <p data-guest-text>
              <strong>
                {t("replayed.cashRefused", {
                  what: s.lines.map((l) => `${l.qty} × ${l.name}`).join(", "),
                  cash: money(s.cash_cents as Cents),
                })}
              </strong>
            </p>
            <p className="small status">
              {t("replayed.cashRefusedWhy", {
                reason: t(`review.reason.${s.reason}` as MessageKey),
                name: s.staff_name,
                time: time(s.queued_at, timeZone),
              })}
            </p>
            <p className="small">{t("replayed.cashRefusedHint")}</p>
            <div className="team-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy === s.id}
                onClick={() => void seen(s)}
              >
                {t("replayed.cashRefusedOk")}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
