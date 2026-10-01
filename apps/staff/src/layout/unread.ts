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
