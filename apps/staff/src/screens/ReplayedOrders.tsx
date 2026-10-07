import { useCallback, useEffect, useState } from "react";
import type { Cents } from "@west4/shared";
import { api, type ApiCallError } from "../api.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";

/**
 * "Confirm replayed orders (3)" (M8-05; spec 09 · Replay; screens N29): the rounds the bar
 * computer queued in the outage, replayed as asked to wait. Each stays off the tab until a
 * bartender accepts it against the tab, which is the sale; a round that was also rung online
 * during the outage is cancelled here, so it's charged once. On the bar POS and the bar orders
 * screen; nothing shows when none are waiting.
 */
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
        if (events.length === 0 || events.some((e) => e.type.startsWith("order."))) void load();
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

  if (orders.length === 0) return null;
  return (
    <section className="card replayed-orders" aria-labelledby="replayed-title">
      <h2 id="replayed-title">{t("connection.banner.replayed", { n: orders.length })}</h2>
      <p className="small">{t("replayed.hint")}</p>
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
      </ul>
    </section>
  );
}
