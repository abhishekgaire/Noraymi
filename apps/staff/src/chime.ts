import { createElement, useEffect, useState } from "react";
import { staffOrderWordsKey } from "@west4/shared";
import { useClock } from "./clock.js";
import { useT } from "./i18n.js";
import { readDevice, signedApi, type StoredDevice } from "./device.js";

/**
 * The bar's chime (M3-16; spec 10 rule 7): a backup to the colors and the
 * phones. On a paired bar or front-desk computer, signed in or locked, it
 * checks for ringing and asked-to-wait orders every 5 seconds and chimes for
 * each new one, and again every minute while any has waited past 2 minutes.
 * Mute silences it for `pos.muteSec` (60 s at West 4); the colors keep changing.
 * The desktop app never throttles its window, so it chimes behind other
 * windows too.
 */
export const CHIME_CHECK_MS = 5_000;
const REPEAT_MS = 60_000;
const MUTE_KEY = "west4.chime.mutedUntil";

let mutedUntil = 0;
const listeners = new Set<() => void>();

export function muteChime(seconds = 60, nowMs = Date.now()): void {
  mutedUntil = nowMs + seconds * 1000;
  try {
    localStorage.setItem(MUTE_KEY, String(mutedUntil));
  } catch {
    // Storage may be blocked; the mute still holds for this window.
  }
  for (const l of listeners) l();
}

export function chimeMutedUntil(): number {
  try {
    const stored = Number(localStorage.getItem(MUTE_KEY) ?? 0);
    if (stored > mutedUntil) mutedUntil = stored;
  } catch {
    // As above.
  }
  return mutedUntil;
}

/** Seconds of mute left, kept current for the Mute button. */
export function useChimeMute(): number {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    const tick = () => setLeft(Math.max(0, Math.ceil((chimeMutedUntil() - Date.now()) / 1000)));
    tick();
    listeners.add(tick);
    const timer = setInterval(tick, 1000);
    return () => {
      listeners.delete(tick);
      clearInterval(timer);
    };
  }, []);
  return left;
}

/** Two short tones through Web Audio. */
export function playChime(): void {
  try {
    const ctx = new AudioContext();
    for (const [i, freq] of [880, 660].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.value = 0.2;
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.2);
      osc.stop(ctx.currentTime + i * 0.2 + 0.18);
    }
    setTimeout(() => void ctx.close(), 1000);
  } catch {
    // No audio device: the screen's colors and the phones still carry it.
  }
}

/** What to do on one check: chime for an order not heard before, or a reminder once a minute for old ones. */
export function chimeDecision(
  orders: readonly { id: string; placed_at: string }[],
  state: { heard: Set<string>; lastRepeat: number },
  nowMs: number,
  agedMs = 120_000,
): boolean {
  const fresh = orders.some((o) => !state.heard.has(o.id));
  for (const o of orders) state.heard.add(o.id);
  const aged = orders.some((o) => nowMs - Date.parse(o.placed_at) >= agedMs);
  const repeat = aged && nowMs - state.lastRepeat >= REPEAT_MS;
  if (fresh || repeat) state.lastRepeat = nowMs;
  return (fresh || repeat) && nowMs >= chimeMutedUntil();
}

async function check(device: StoredDevice, state: { heard: Set<string>; lastRepeat: number }) {
  const r = await signedApi<{
    orders: { id: string; placed_at: string }[];
    aging?: { amber_sec: number; chime: boolean };
  }>(device, "GET", `/v1/venues/${device.venueId}/orders?status=ringing,held`).catch(() => null);
  // The venue's chime switch and amber time (Admin → Bar POS, M6-25); the colors keep changing either way.
  if (!r || r.aging?.chime === false) return;
  if (chimeDecision(r.orders, state, Date.now(), (r.aging?.amber_sec ?? 120) * 1000)) playChime();
}

/** Runs on paired bar and front-desk computers inside the desktop app, for as long as the app runs. */
export function ChimeLoop() {
  useEffect(() => {
    if (typeof window === "undefined" || !window.west4) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    let live = true;
    void readDevice().then((device) => {
      if (!live || !device || (device.kind !== "bar_computer" && device.kind !== "front_desk"))
        return;
      const state = { heard: new Set<string>(), lastRepeat: 0 };
      // The orders already waiting when the app opens are heard once, not chimed for again.
      timer = setInterval(() => void check(device, state), CHIME_CHECK_MS);
      void check(device, state);
    });
    return () => {
      live = false;
      if (timer) clearInterval(timer);
    };
  }, []);
  return null;
}

/**
 * On a locked bar or front-desk screen (M3-16): the orders waiting at the bar,
 * so a new one still shows there while nobody is signed in. The chime loop
 * chimes for it at the same time. Each one ages on screen without a PIN, and
 * offline (M8-03) the desktop app's cache keeps them here, still aging.
 */
interface LockedOrder {
  readonly id: string;
  readonly room_name: string | null;
  readonly status: string;
  readonly cancel_reason: string | null;
  readonly placed_at: string;
}

export function WaitingWhileLocked({ device }: { device: StoredDevice }) {
  const { t } = useT();
  const { now } = useClock();
  const [waiting, setWaiting] = useState<readonly LockedOrder[]>([]);
  useEffect(() => {
    if (device.kind !== "bar_computer" && device.kind !== "front_desk") return;
    const check = () =>
      void signedApi<{ orders: LockedOrder[] }>(
        device,
        "GET",
        `/v1/venues/${device.venueId}/orders?status=ringing,held`,
      )
        .then((r) => setWaiting(r.orders))
        .catch(() => undefined);
    check();
    const timer = setInterval(check, CHIME_CHECK_MS);
    return () => clearInterval(timer);
  }, [device]);
  if (waiting.length === 0) return null;
  const nowMs = now?.epochMilliseconds ?? Date.now();
  const mmss = (iso: string) => {
    const s = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  return createElement(
    "div",
    { className: "notice waiting-orders", "data-testid": "waiting-orders" },
    createElement("p", { "aria-live": "polite" }, t("signIn.ordersWaiting", { n: waiting.length })),
    createElement(
      "ul",
      null,
      ...waiting.map((o) =>
        createElement(
          "li",
          { key: o.id },
          t("signIn.orderWaiting", {
            room: o.room_name ?? "",
            words: t(staffOrderWordsKey(o), { age: mmss(o.placed_at) }),
          }),
        ),
      ),
    ),
  );
}
