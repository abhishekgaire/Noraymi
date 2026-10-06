import { describe, expect, it } from "vitest";
import {
  currentRound,
  drinkCreditUnits,
  moveSwap,
  placeNewSong,
  songFlag,
  upNext,
  type QueuedSong,
} from "./song-queue.js";

// The seed's queue at 10:41 PM: round 3, Luis M. singing, six queued.
const seed: QueuedSong[] = [
  { id: "luis", singerId: "sg_luis", round: 3, position: 1, status: "singing" },
  { id: "jess", singerId: "sg_jess", round: 3, position: 2, status: "queued" },
  { id: "kira", singerId: "sg_kira", round: 3, position: 3, status: "queued" },
  { id: "ben", singerId: "sg_ben", round: 3, position: 4, status: "queued" },
  { id: "tariq", singerId: "sg_tariq", round: 3, position: 5, status: "queued" },
  { id: "hana", singerId: "sg_hana", round: 3, position: 6, status: "queued" },
  { id: "sofia", singerId: "sg_sofia", round: 3, position: 7, status: "queued" },
];

describe("the rotation", () => {
  it("is round 3 while Luis M. sings", () => {
    expect(currentRound(seed)).toBe(3);
    expect(upNext(seed).map((s) => s.id)).toEqual([
      "jess",
      "kira",
      "ben",
      "tariq",
      "hana",
      "sofia",
    ]);
  });

  it("puts a second song from Jess P. into round 4, not round 3", () => {
    expect(placeNewSong(seed, "sg_jess", 1)).toEqual({ round: 4, position: 1 });
    expect(placeNewSong(seed, "sg_luis", 1)).toEqual({ round: 4, position: 1 });
  });

  it("puts a new singer at the end of the current round, in join order", () => {
    expect(placeNewSong(seed, "sg_new", 1)).toEqual({ round: 3, position: 8 });
    const after = [
      ...seed,
      { id: "n1", singerId: "sg_new", round: 3, position: 8, status: "queued" as const },
    ];
    expect(placeNewSong(after, "sg_next", 1)).toEqual({ round: 3, position: 9 });
    expect(placeNewSong(after, "sg_new", 1)).toEqual({ round: 4, position: 1 });
  });

  it("lets a singer have songsPerRound songs in a round", () => {
    expect(placeNewSong(seed, "sg_jess", 2)).toEqual({ round: 3, position: 8 });
    const two = [
      ...seed,
      { id: "j2", singerId: "sg_jess", round: 3, position: 8, status: "queued" as const },
    ];
    expect(placeNewSong(two, "sg_jess", 2)).toEqual({ round: 4, position: 1 });
  });

  it("doesn't count a skipped or removed song toward the round", () => {
    const skipped = seed.map((s) => (s.id === "jess" ? { ...s, status: "skipped" as const } : s));
    expect(placeNewSong(skipped, "sg_jess", 1)).toEqual({ round: 3, position: 8 });
  });

  it("follows the round when nobody is singing", () => {
    expect(currentRound([])).toBe(1);
    expect(placeNewSong([], "a", 1)).toEqual({ round: 1, position: 1 });
    const sung = seed.map((s) => ({ ...s, status: "sung" as const }));
    expect(currentRound(sung)).toBe(3);
    const nextUp = [
      ...sung,
      { id: "x", singerId: "sg_jess", round: 4, position: 1, status: "queued" as const },
    ];
    expect(currentRound(nextUp)).toBe(4);
  });

  it("refuses a limit that isn't a whole number of at least 1", () => {
    expect(() => placeNewSong(seed, "a", 0)).toThrow(RangeError);
  });
});

describe("a staff move", () => {
  it("swaps Sofia R. with Hana K. when she moves up", () => {
    expect(moveSwap(seed, "sofia", "up")).toEqual([
      { id: "sofia", round: 3, position: 6 },
      { id: "hana", round: 3, position: 7 },
    ]);
  });

  it("can't move past either end or the song singing", () => {
    expect(moveSwap(seed, "jess", "up")).toBeNull();
    expect(moveSwap(seed, "sofia", "down")).toBeNull();
    expect(moveSwap(seed, "luis", "down")).toBeNull();
  });

  it("crosses into the next round, trading rounds", () => {
    const next = [
      ...seed,
      { id: "j2", singerId: "sg_jess", round: 4, position: 1, status: "queued" as const },
    ];
    expect(moveSwap(next, "j2", "up")).toEqual([
      { id: "j2", round: 3, position: 7 },
      { id: "sofia", round: 4, position: 1 },
    ]);
  });
});

describe("drink credits", () => {
  it("gives Tariq A. one credit for the Large bucket and one for the Modelo", () => {
    const units = drinkCreditUnits([
      { id: 1, kind: "item", qty: 1, taxCategory: "drink", reversesId: null },
      { id: 2, kind: "item", qty: 1, taxCategory: "drink", reversesId: null },
    ]);
    expect([...units.values()].reduce((a, b) => a + b, 0)).toBe(2);
  });

  it("gives one per unit sold, none for a comped or voided unit, none for food or songs", () => {
    const units = drinkCreditUnits([
      { id: 1, kind: "item", qty: 2, taxCategory: "drink", reversesId: null },
      { id: 2, kind: "item", qty: 1, taxCategory: "drink", reversesId: null },
      { id: 3, kind: "comp", qty: 1, taxCategory: "drink", reversesId: 2 },
      { id: 4, kind: "item", qty: 3, taxCategory: "drink", reversesId: null },
      { id: 5, kind: "void", qty: 1, taxCategory: "drink", reversesId: 4 },
      { id: 6, kind: "item", qty: 1, taxCategory: "food", reversesId: null },
      { id: 7, kind: "song", qty: 1, taxCategory: "song", reversesId: null },
    ]);
    expect(Object.fromEntries(units)).toEqual({ 1: 2, 2: 0, 4: 2 });
  });
});

describe("the flag", () => {
  it("flags a song with no credit and no song price", () => {
    expect(songFlag({ holdsCredit: false, songPriceCents: null })).toBe("needs_drink_credit");
    expect(songFlag({ holdsCredit: true, songPriceCents: null })).toBeNull();
    expect(songFlag({ holdsCredit: false, songPriceCents: 500 })).toBeNull();
  });
});
