import { NetworkError, api } from "./api.js";

/**
 * The timed staff trial's capture (M9-11; spec 13 · Tests, Timed staff trial). While the person
 * or this screen is in training, every tap on a staff screen is kept with the button's own words
 * and the screen's path, with the errors the screen showed and a badge take-over's two moments,
 * and sent every 10 seconds to POST /v1/venues/{v}/trial-events. Live work is never captured:
 * the shell starts it only in training, and the API refuses it outside training.
 */
export type TrialKind = "tap" | "error" | "badge" | "signed_in";

export interface TrialEvent {
  readonly kind: TrialKind;
  readonly label?: string;
  readonly screen?: string;
  readonly at: string;
}

const TAPPABLE =
  'button, a, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], input, select, label';
const MAX_BUFFER = 1000;
const FLUSH_MS = 10_000;

let venue: string | null = null;
let buffer: TrialEvent[] = [];

const screen = () =>
  typeof location === "undefined" ? undefined : location.pathname.slice(0, 120);

/** The tapped control's own words: its aria-label, else its text, one line, at most 80 characters. */
export function labelOf(target: EventTarget | null): string | undefined {
  const el =
    target && typeof (target as Element).closest === "function"
      ? (target as Element).closest(TAPPABLE)
      : null;
  if (!el) return undefined;
  const words = (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
  return words ? words.slice(0, 80) : undefined;
}

/** Keeps one moment, only while the capture runs. */
export function trialMark(kind: TrialKind, label?: string, at: Date = new Date()): void {
  const s = screen();
  const event: TrialEvent = {
    kind,
    ...(label ? { label: label.slice(0, 80) } : {}),
    ...(s ? { screen: s } : {}),
    at: at.toISOString(),
  };
  if (!venue) {
    // A take-over can happen between two people's screens: held briefly for the next capture.
    if (kind === "badge" || kind === "signed_in") held = [...held, event].slice(-2);
    return;
  }
  if (buffer.length >= MAX_BUFFER) buffer.shift();
  buffer.push(event);
}

/** A take-over's moments marked while no capture ran, kept for one minute. */
let held: TrialEvent[] = [];
const HELD_MS = 60_000;

/** The capture's own path: its errors are never captured. */
export const TRIAL_PATH = /\/trial-events$/;

type Post = (venueId: string, events: readonly TrialEvent[]) => Promise<unknown>;

const defaultPost: Post = (venueId, events) =>
  api("POST", `/v1/venues/${venueId}/trial-events`, { events });

/** Sends what's kept, 200 at a time. A network failure keeps them for the next try. */
export async function flushTrial(post: Post = defaultPost): Promise<void> {
  const v = venue;
  while (v && buffer.length > 0) {
    const batch = buffer.slice(0, 200);
    try {
      await post(v, batch);
    } catch (e) {
      // Offline: try again later. Refused (not in training any more): drop them.
      if (e instanceof NetworkError) return;
    }
    buffer = buffer.slice(batch.length);
  }
}

/** Starts the capture for a venue; the returned function sends what's left and stops it. */
export function startTrialCapture(venueId: string, post: Post = defaultPost): () => void {
  venue = venueId;
  const now = Date.now();
  buffer.push(...held.filter((e) => now - Date.parse(e.at) <= HELD_MS));
  held = [];
  const onTap = (e: Event) => trialMark("tap", labelOf(e.target));
  document.addEventListener("pointerdown", onTap, { capture: true });
  const timer = setInterval(() => void flushTrial(post), FLUSH_MS);
  return () => {
    document.removeEventListener("pointerdown", onTap, { capture: true });
    clearInterval(timer);
    void flushTrial(post).finally(() => {
      if (venue === venueId) {
        venue = null;
        buffer = [];
      }
    });
  };
}

/** For tests: what's kept now. */
export const trialBuffer = (): readonly TrialEvent[] => buffer;
