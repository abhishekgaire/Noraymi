import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { useEvents } from "../events.js";

/** The message badge (M2-22): unread guest texts, kept live by message events. */
export function useUnreadTexts(venueId: string, canText: boolean): number {
  const { subscribe } = useEvents();
  const [unread, setUnread] = useState(0);
  const load = useCallback(async () => {
    if (!canText || !venueId) return;
    try {
      setUnread(
        (await api<{ unread: number }>("GET", `/v1/venues/${venueId}/conversations`)).unread,
      );
    } catch {
      // The badge is a convenience; the screens keep working without it.
    }
  }, [venueId, canText]);
  useEffect(() => void load(), [load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (events.length === 0 || events.some((e) => e.type.startsWith("message."))) void load();
      }),
    [subscribe, load],
  );
  return unread;
}

/** The bar's count (M3-16): ringing and asked-to-wait orders, kept live by order events. */
export function useWaitingOrders(venueId: string, canAccept: boolean): number {
  const { subscribe } = useEvents();
  const [waiting, setWaiting] = useState(0);
  const load = useCallback(async () => {
    if (!canAccept || !venueId) return;
    try {
      setWaiting(
        (
          await api<{ orders: unknown[] }>(
            "GET",
            `/v1/venues/${venueId}/orders?status=ringing,held`,
          )
        ).orders.length,
      );
    } catch {
      // The count is a convenience; the bar orders screen has the list.
    }
  }, [venueId, canAccept]);
  useEffect(() => void load(), [load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (events.length === 0 || events.some((e) => e.type.startsWith("order."))) void load();
      }),
    [subscribe, load],
  );
  return waiting;
}
