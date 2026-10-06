import { useSyncExternalStore } from "react";

/**
 * The desktop app's read-only offline view (M8-03): when our API doesn't
 * answer, the board, open tabs, the menu and the bar's orders come from the
 * encrypted cache, as of the last sync. This keeps when that was: the oldest
 * kept answer a screen has shown since the last live one, so the words never
 * claim a total is newer than it is.
 */
let keptAt: string | null = null;
const listeners = new Set<() => void>();

const emit = () => {
  for (const l of listeners) l();
};

/** A kept answer was shown: its venue sync time. */
export function noteKept(syncedAt: string): void {
  if (keptAt !== null && keptAt <= syncedAt) return;
  keptAt = syncedAt;
  emit();
}

/** A live answer arrived: what's on screen is current again. */
export function noteLive(): void {
  if (keptAt === null) return;
  keptAt = null;
  emit();
}

/** The venue time of the oldest kept answer on screen, or null while everything is live. */
export function useKeptAt(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => keptAt,
    () => null,
  );
}

/** The desktop shell's offline store, or null in a browser or on a phone (they get no offline view). */
export function offlineStore(): NonNullable<NonNullable<Window["west4"]>["offline"]> | null {
  return typeof window === "undefined" ? null : (window.west4?.offline ?? null);
}
