import { offlinePrefetchPaths } from "@west4/shared";
import { useEffect, useRef, type ReactNode } from "react";
import { api } from "../api.js";
import { deviceOnlyApi, isShared, readDevice } from "../device.js";
import { useVenueTime } from "../clock.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";
import { offlineStore, useKeptAt } from "../offline.js";
import { useQueue } from "../queue.js";

/**
 * Under the pink banner (M8-03; spec 09 · Offline and queue mode) the board,
 * the bar POS and the bar orders screen are read-only: every control that
 * would write is disabled, with the reason in words, and the totals say
 * they're as of the last sync. A control that only changes what's shown
 * (picking a tab to see its lines, a menu section, Mute, Lock) carries
 * `data-view` and stays live. Nothing here writes, locally or to the cloud.
 */
const CONTROLS = "button, input, select, textarea";

export function ReadOnlyWhileOffline({
  active,
  timeZone,
  children,
}: {
  active: boolean;
  timeZone: string;
  children: ReactNode;
}) {
  const { t, time } = useT();
  const keptAt = useKeptAt();
  const ref = useRef<HTMLDivElement>(null);
  // Queue mode (M8-04): rounds on open tabs queue on this computer (`data-queue` controls); the rest
  // (voids, refunds, the drawer, New tab) stays locked, saying why.
  const queueing = useQueue().state.open;
  const reason = queueing ? t("queue.locked.control") : t("offline.readOnly.control");
  const live = queueing ? "[data-view], [data-queue]" : "[data-view]";
  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;
    // What this effect disabled, and each one's own title, so going back online restores exactly that.
    const touched = new Map<HTMLButtonElement, string | null>();
    const apply = () => {
      for (const el of root.querySelectorAll<HTMLButtonElement>(CONTROLS)) {
        if (el.disabled || el.closest(live)) continue;
        touched.set(el, el.getAttribute("title"));
        el.disabled = true;
        el.setAttribute("title", reason);
        el.dataset["offlineReadOnly"] = "";
      }
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["disabled"],
    });
    return () => {
      observer.disconnect();
      for (const [el, title] of touched) {
        el.disabled = false;
        if (title === null) el.removeAttribute("title");
        else el.setAttribute("title", title);
        delete el.dataset["offlineReadOnly"];
      }
    };
  }, [active, reason, live]);
  return (
    <div ref={ref} className={active ? "read-only-offline" : undefined}>
      {active && (
        <p className="notice read-only-note" role="note" data-testid="read-only-note">
          {queueing
            ? t("queue.note")
            : keptAt
              ? t("offline.readOnly.asOf", { time: time(keptAt, timeZone) })
              : t("offline.readOnly.note")}
        </p>
      )}
      {children}
    </div>
  );
}

/** How often the desktop app refreshes what it keeps, besides every event (it never asks more often). */
export const OFFLINE_SYNC_MS = 60_000;
const MIN_GAP_MS = 10_000;

/**
 * The desktop app keeps the current business date's board, open tabs and
 * their lines, the menu and the bar's orders fresh in its encrypted cache,
 * whichever screen is open: on every event from the stream, and once a
 * minute. Each read lands in the cache through `api` itself.
 */
export function OfflineSync({
  venueId,
  timeZone,
  cutover,
}: {
  venueId: string;
  timeZone: string;
  cutover: string;
}) {
  const { subscribe } = useEvents();
  const night = useVenueTime(timeZone, cutover)?.businessDate.toString() ?? null;
  const last = useRef(0);
  const nightRef = useRef(night);
  nightRef.current = night;
  useEffect(() => {
    if (!offlineStore()) return;
    let live = true;
    const sync = async () => {
      if (Date.now() - last.current < MIN_GAP_MS) return;
      last.current = Date.now();
      const reads = offlinePrefetchPaths(venueId, nightRef.current);
      const answers = await Promise.all(reads.map((p) => api<unknown>("GET", p).catch(() => null)));
      if (!live) return;
      // Each open tab's and room's check, so its lines can be seen offline too.
      const checks = new Set<string>();
      const tabs = answers[reads.indexOf(`/v1/venues/${venueId}/tabs`)] as {
        tabs?: { check_id?: string; open?: boolean }[];
      } | null;
      for (const tab of tabs?.tabs ?? []) if (tab.open && tab.check_id) checks.add(tab.check_id);
      const board = answers[reads.indexOf(`/v1/venues/${venueId}/board`)] as {
        rooms?: { session?: { check_id?: string | null } | null }[];
      } | null;
      for (const room of board?.rooms ?? [])
        if (room.session?.check_id) checks.add(room.session.check_id);
      await Promise.all(
        [...checks].map((id) =>
          api<unknown>("GET", `/v1/venues/${venueId}/checks/${id}`).catch(() => null),
        ),
      );
      // The team's name tiles, signed by the computer (M8-04): queue mode's "who's ringing it".
      const device = await readDevice().catch(() => null);
      if (device && device.venueId === venueId && isShared(device))
        await deviceOnlyApi<unknown>(device, "GET", `/v1/venues/${venueId}/team/tiles`).catch(
          () => null,
        );
    };
    void sync();
    const timer = setInterval(() => void sync(), OFFLINE_SYNC_MS);
    const unsubscribe = subscribe(() => void sync());
    return () => {
      live = false;
      clearInterval(timer);
      unsubscribe();
    };
  }, [venueId, subscribe]);
  return null;
}
