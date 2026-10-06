import {
  isOfflineRead,
  OFFLINE_MAX_BYTES,
  type OfflineSnapshot,
  type Temporal,
} from "@west4/shared";
import type { DesktopCache } from "./cache.js";

/**
 * The read-only offline view (M8-03; spec 09 · Offline and queue mode): the
 * answers to the reads the staff app makes for the board, open tabs, the menu
 * and the bar's orders, kept in the encrypted cache for the current business
 * date only. The staff app hands each answer over as it arrives; offline it
 * reads them back. Only the reads on the shared list are kept, and nothing the
 * screens do offline writes here: the cloud stays the only writer.
 */
const KIND = "read";

/** Keep one answer. Returns false (keeping nothing) for a read that isn't on the list, or one too big. */
export function saveOfflineRead(
  cache: DesktopCache,
  now: Temporal.Instant,
  path: unknown,
  json: unknown,
): boolean {
  if (typeof path !== "string" || !isOfflineRead(path)) return false;
  if (typeof json !== "string" || json.length > OFFLINE_MAX_BYTES) return false;
  let body: unknown;
  try {
    body = JSON.parse(json);
  } catch {
    return false;
  }
  const snapshot: OfflineSnapshot = { synced_at: now.toString(), body };
  cache.put(now, KIND, path, snapshot);
  return true;
}

/** The kept answer for one read, or null. Past the cutover the day before is gone first. */
export function readOfflineRead(
  cache: DesktopCache,
  now: Temporal.Instant,
  path: unknown,
): OfflineSnapshot | null {
  if (typeof path !== "string" || !isOfflineRead(path)) return null;
  cache.wipeIfPastCutover(now);
  return cache.get<OfflineSnapshot>(KIND, path);
}
