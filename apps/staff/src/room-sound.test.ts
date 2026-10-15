import { describe, expect, it } from "vitest";
import {
  EMPTY_ROOM_SOUND,
  clearAllRooms,
  dismissRoom,
  roomSoundDecision,
  type BoardForSound,
  type RoomSoundState,
} from "./room-sound.js";

const room = (name: string, session: string | null, tone: "amber" | "red" | null) => ({
  room_id: `r-${name}`,
  name,
  tone,
  session: session ? { id: session } : null,
});
const board = (rooms: BoardForSound["rooms"], on = true): BoardForSound => ({
  rooms,
  room_sound: { on, volume: 50 },
});

/** Runs several board reads in a row, carrying the state, as the loop does. */
function run(reads: BoardForSound[], start: RoomSoundState = EMPTY_ROOM_SOUND) {
  let state = start;
  const plays: boolean[] = [];
  for (const b of reads) {
    const r = roomSoundDecision(b, state);
    plays.push(r.play);
    state = r.state;
  }
  return { plays, state };
}

describe("Sound when a room's time is up (P-05)", () => {
  it("plays once when a room reaches Wrap up and once more when its time passes", () => {
    const { plays, state } = run([
      board([room("Room 9", "s9", null)]),
      board([room("Room 9", "s9", "amber")]),
      board([room("Room 9", "s9", "amber")]),
      board([room("Room 9", "s9", "red")]),
      board([room("Room 9", "s9", "red")]),
    ]);
    expect(plays).toEqual([false, true, false, true, false]);
    // Only the newer step stays on screen.
    expect(state.shown.map((s) => s.key)).toEqual(["s9:past"]);
  });

  it("isn't repeated on reload: the stored state carries what was played", () => {
    const first = run([board([room("Room 9", "s9", "amber")])]);
    // A reload reads the stored state back (JSON round trip) and the board again.
    const stored = JSON.parse(JSON.stringify(first.state)) as RoomSoundState;
    const again = run([board([room("Room 9", "s9", "amber")])], stored);
    expect(first.plays).toEqual([true]);
    expect(again.plays).toEqual([false]);
    expect(again.state.shown.map((s) => s.room)).toEqual(["Room 9"]);
  });

  it("keeps the room's name on screen until a tap clears it, and a tap doesn't replay it", () => {
    const a = run([board([room("Room 9", "s9", "amber"), room("Room 3", "s3", "amber")])]);
    expect(a.plays).toEqual([true]);
    expect(a.state.shown.map((s) => s.room)).toEqual(["Room 9", "Room 3"]);
    const tapped = dismissRoom(a.state, "s9:wrap_up");
    const b = run([board([room("Room 9", "s9", "amber"), room("Room 3", "s3", "amber")])], tapped);
    expect(b.plays).toEqual([false]);
    expect(b.state.shown.map((s) => s.room)).toEqual(["Room 3"]);
  });

  it("a room already past when first seen sounds once, not for its Wrap up too", () => {
    const { plays, state } = run([board([room("Room 4", "s4", "red")])]);
    expect(plays).toEqual([true]);
    expect(state.shown.map((s) => s.key)).toEqual(["s4:past"]);
  });

  it("a new session in the same room sounds again; a closed-out session is forgotten", () => {
    const { plays, state } = run([
      board([room("Room 9", "s9", "amber")]),
      board([room("Room 9", null, null)]),
      board([room("Room 9", "s9b", "amber")]),
    ]);
    expect(plays).toEqual([true, false, true]);
    expect(state.heard).toEqual(["s9b:wrap_up"]);
    expect(state.shown.map((s) => s.key)).toEqual(["s9b:wrap_up"]);
  });

  it("with the setting off plays and shows nothing, and turning it on doesn't play a backlog", () => {
    const { plays, state } = run([
      board([room("Room 9", "s9", "amber")], false),
      board([room("Room 9", "s9", "amber")], true),
      board([room("Room 9", "s9", "red")], true),
    ]);
    expect(plays).toEqual([false, false, true]);
    expect(state.shown.map((s) => s.key)).toEqual(["s9:past"]);
    const off = run([board([room("Room 2", "s2", "red")], false)]);
    expect(off.plays).toEqual([false]);
    expect(off.state.shown).toEqual([]);
  });

  it("the strip names each room's id and its tile's newest words, and Clear all clears them (U-18)", () => {
    const tile = (min: number) => ({
      ...room("Room 7", "s7", "red"),
      words: { kind: "needed_now", minutes_past: min },
    });
    const a = run([board([tile(11)])]);
    expect(a.state.shown).toMatchObject([
      { room: "Room 7", room_id: "r-Room 7", words: { kind: "needed_now", minutes_past: 11 } },
    ]);
    const b = run([board([tile(12)])], a.state);
    expect(b.plays).toEqual([false]);
    expect(b.state.shown[0]!.words).toEqual({ kind: "needed_now", minutes_past: 12 });
    const cleared = clearAllRooms(b.state);
    expect(cleared.shown).toEqual([]);
    expect(run([board([tile(13)])], cleared)).toMatchObject({
      plays: [false],
      state: { shown: [] },
    });
  });
});
