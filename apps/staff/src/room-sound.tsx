import { useEffect, useSyncExternalStore } from "react";
import { useNavigate } from "react-router";
import { useT } from "./i18n.js";
import { isShared, readDevice, signedApi, type StoredDevice } from "./device.js";
import { roomPath } from "./layout/bell-items.js";

/**
 * Sound when a room's time is up (P-05; spec 09 · The bar computer's sounds). On a paired bar or
 * front-desk computer, in the desktop app or the staff app in a browser, signed in or locked: it
 * reads the board every 15 seconds and plays a sound once when a room's tile turns amber (Wrap up)
 * and once more when it turns red (its time is past). What it has played is kept on the computer,
 * so a reload never plays it again. The setting lives in Admin → Alerts & rules
 * (`alerts.roomSound`, `alerts.roomSoundVolume`); the guest's room tablet and the guest web never
 * play it.
 *
 * The rooms' names show in the "Time's up" strip (U-18), inside the shell's bands under the top of
 * every signed-in screen (never on the sign-in or lock screen), in the tile's own words, until
 * someone taps one (which clears it and opens that room's panel) or Clear all.
 */
export const ROOM_SOUND_CHECK_MS = 15_000;
const STORE_KEY = "west4.roomSound";

export type RoomStep = "wrap_up" | "past";

/** The tile's words the strip reuses (the board's `words`). */
export interface TileWordsForStrip {
  readonly kind: string;
  readonly minutes_left?: number;
  readonly minutes_past?: number;
}

/** The board's part this reads: each room's tone and session, and the venue's sound setting. */
export interface BoardForSound {
  readonly rooms: readonly {
    readonly room_id: string;
    readonly name: string;
    readonly tone: "amber" | "red" | null;
    readonly words?: TileWordsForStrip;
    readonly session: { readonly id: string; readonly training?: boolean } | null;
  }[];
  readonly room_sound?: { readonly on: boolean; readonly volume: number };
}

export interface ShownRoom {
  /** `<session id>:<step>`: one sound per room per step. */
  readonly key: string;
  readonly session_id: string;
  readonly room: string;
  readonly step: RoomStep;
  /** Opens the room's panel (U-18); absent on a name kept from before U-18. */
  readonly room_id?: string;
  /** The tile's words at the last read (U-18). */
  readonly words?: TileWordsForStrip;
}

export interface RoomSoundState {
  /** Every step already sounded for a session still on the board. */
  readonly heard: readonly string[];
  /** On screen until someone taps it. */
  readonly shown: readonly ShownRoom[];
}

export const EMPTY_ROOM_SOUND: RoomSoundState = { heard: [], shown: [] };

function stepOf(tone: "amber" | "red" | null): RoomStep | null {
  return tone === "red" ? "past" : tone === "amber" ? "wrap_up" : null;
}

/**
 * One board read: the steps not heard before are sounded (once, whatever their number) and shown;
 * a room that moves on from Wrap up to past shows the newer step only; a session that left the board
 * (closed out) is forgotten. With the setting off nothing plays or shows, and nothing is marked
 * heard, so turning it back on sounds only for the rooms that reach a step after that. The names
 * still on screen take the tile's newest words.
 */
export function roomSoundDecision(
  board: BoardForSound,
  state: RoomSoundState,
): { play: boolean; state: RoomSoundState } {
  const live = new Map<string, RoomStep>();
  const tiles = new Map<string, BoardForSound["rooms"][number]>();
  const fresh: ShownRoom[] = [];
  const heard = new Set(state.heard);
  const on = board.room_sound?.on !== false;
  for (const r of board.rooms) {
    const step = stepOf(r.tone);
    if (!r.session || !step) continue;
    live.set(r.session.id, step);
    tiles.set(r.session.id, r);
    const key = `${r.session.id}:${step}`;
    if (heard.has(key)) continue;
    // Off: the step still counts as heard, so turning the sound on later doesn't play a backlog.
    heard.add(key);
    // A room already past when first seen isn't sounded for its Wrap up too.
    if (step === "past") heard.add(`${r.session.id}:wrap_up`);
    if (on)
      fresh.push({
        key,
        session_id: r.session.id,
        room: r.name,
        step,
        room_id: r.room_id,
        ...(r.words ? { words: r.words } : {}),
      });
  }
  const kept = state.shown
    .filter(
      (s) =>
        live.has(s.session_id) &&
        !fresh.some((f) => f.session_id === s.session_id) &&
        // Only the step the tile is at now stays on screen.
        (s.step === live.get(s.session_id) || s.step === "past"),
    )
    .map((s) => {
      const tile = tiles.get(s.session_id);
      return tile
        ? { ...s, room_id: tile.room_id, ...(tile.words ? { words: tile.words } : {}) }
        : s;
    });
  const stillHeard = [...heard].filter((k) => live.has(k.slice(0, k.lastIndexOf(":"))));
  return {
    play: fresh.length > 0,
    state: { heard: stillHeard, shown: on ? [...kept, ...fresh] : [] },
  };
}

/** A tap on a room's name clears it from the screen. */
export function dismissRoom(state: RoomSoundState, key: string): RoomSoundState {
  return { ...state, shown: state.shown.filter((s) => s.key !== key) };
}

/** Clear all (U-18): every name off the strip; nothing plays again for those steps. */
export function clearAllRooms(state: RoomSoundState): RoomSoundState {
  return { ...state, shown: [] };
}

export function readRoomSound(): RoomSoundState {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return EMPTY_ROOM_SOUND;
    const parsed = JSON.parse(raw) as Partial<RoomSoundState>;
    return {
      heard: Array.isArray(parsed.heard) ? parsed.heard.filter((k) => typeof k === "string") : [],
      shown: Array.isArray(parsed.shown) ? parsed.shown : [],
    };
  } catch {
    return EMPTY_ROOM_SOUND;
  }
}

function writeRoomSound(state: RoomSoundState): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    // Storage may be blocked: this window still remembers what it played.
  }
}

/** The names on screen, shared by the loop (which reads the board) and the strip (which shows them). */
let current: readonly ShownRoom[] = [];
const listeners = new Set<() => void>();
function publish(shown: readonly ShownRoom[]): void {
  current = shown;
  for (const l of listeners) l();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
/** The rooms waiting on the "Time's up" strip. */
export function useTimeUp(): readonly ShownRoom[] {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  );
}

let playing: AudioContext | null = null;

/** Three falling tones through Web Audio at the venue's volume (0 to 100); a tap stops them. */
export function playRoomSound(volume: number): void {
  if (volume <= 0) return;
  try {
    stopRoomSound();
    const ctx = new AudioContext();
    playing = ctx;
    for (const [i, freq] of [988, 784, 587].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.value = 0.4 * (Math.min(100, volume) / 100);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.3);
      osc.stop(ctx.currentTime + i * 0.3 + 0.26);
    }
    setTimeout(() => {
      if (playing === ctx) stopRoomSound();
    }, 1500);
  } catch {
    // No audio device: the room's name on screen and the tile's color still carry it.
  }
}

function stopRoomSound(): void {
  const ctx = playing;
  playing = null;
  if (ctx) void ctx.close().catch(() => undefined);
}

/** Mounted once for the whole app, signed in or locked: reads the board and plays the sound. */
export function RoomSoundLoop() {
  useEffect(() => {
    let live = true;
    // The device is read on every check, so a screen paired after the app opened starts at once.
    const check = () =>
      void readDevice().then((device: StoredDevice | null) => {
        if (!live || !isShared(device)) return;
        return (
          signedApi<BoardForSound>(device, "GET", `/v1/venues/${device.venueId}/board`)
            .then((board) => {
              if (!live) return;
              const next = roomSoundDecision(board, readRoomSound());
              writeRoomSound(next.state);
              publish(next.state.shown);
              if (next.play) playRoomSound(board.room_sound?.volume ?? 50);
            })
            // Rooms switched off, or the API out of reach: nothing to sound.
            .catch(() => undefined)
        );
      });
    publish(readRoomSound().shown);
    check();
    const timer = setInterval(check, ROOM_SOUND_CHECK_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  return null;
}

/**
 * The "Time's up" strip (U-18), in the shell's bands: each room in its tile's words (Wrap up ·
 * 4 min left, Staying · 41 min past, Needed now · 11 min past). A tap clears that name and opens
 * the room's panel; Clear all clears every one.
 */
export function TimeUpStrip() {
  const { t } = useT();
  const navigate = useNavigate();
  const shown = useTimeUp();
  if (shown.length === 0) return null;
  const words = (s: ShownRoom) => {
    const w = s.words;
    if (!w) return null;
    if (w.kind === "in_room") return t("session.inRoom", { min: w.minutes_left ?? 0 });
    if (w.kind === "wrap_up") return t("board.wrapUp", { min: w.minutes_left ?? 0 });
    if (w.kind === "needed_now") return t("session.neededNow", { min: w.minutes_past ?? 0 });
    if (w.kind === "staying") return t("session.staying", { min: w.minutes_past ?? 0 });
    return null;
  };
  const save = (next: RoomSoundState) => {
    writeRoomSound(next);
    publish(next.shown);
  };
  return (
    <div
      className="room-sound"
      role="region"
      aria-label={t("roomSound.title")}
      aria-live="assertive"
      data-testid="room-sound"
    >
      <p className="small">{t("roomSound.title")}</p>
      {shown.map((s) => {
        const w = words(s);
        return (
          <button
            key={s.key}
            type="button"
            className={`room-sound-room ${s.step === "past" ? "red" : "amber"}`}
            onClick={() => {
              stopRoomSound();
              save(dismissRoom(readRoomSound(), s.key));
              if (s.room_id) void navigate(roomPath(s.room_id));
            }}
          >
            {w ? t("roomSound.line", { room: s.room, words: w }) : s.room}
          </button>
        );
      })}
      <button
        type="button"
        className="secondary room-sound-clear"
        onClick={() => {
          stopRoomSound();
          save(clearAllRooms(readRoomSound()));
        }}
      >
        {t("roomSound.clearAll")}
      </button>
    </div>
  );
}
