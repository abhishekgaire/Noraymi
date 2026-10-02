import { describe, expect, it } from "vitest";
import { chimeDecision, muteChime } from "./chime.js";

const order = (id: string, placedMs: number) => ({
  id,
  placed_at: new Date(placedMs).toISOString(),
});

describe("the bar's chime", () => {
  it("chimes for a new order, not again for the same one, and once a minute while one has waited 2 minutes", () => {
    const state = { heard: new Set<string>(), lastRepeat: 0 };
    const t0 = Date.parse("2026-09-25T22:41:00-04:00");
    expect(chimeDecision([order("o1", t0)], state, t0)).toBe(true);
    expect(chimeDecision([order("o1", t0)], state, t0 + 5_000)).toBe(false);
    expect(chimeDecision([order("o1", t0)], state, t0 + 120_000)).toBe(true);
    expect(chimeDecision([order("o1", t0)], state, t0 + 150_000)).toBe(false);
    expect(chimeDecision([order("o1", t0)], state, t0 + 180_000)).toBe(true);
  });

  it("Mute silences it for 60 seconds", () => {
    const state = { heard: new Set<string>(), lastRepeat: 0 };
    const t0 = Date.now();
    muteChime(60, t0);
    expect(chimeDecision([order("o9", t0)], state, t0 + 1_000)).toBe(false);
    expect(chimeDecision([order("o9", t0), order("o10", t0)], state, t0 + 61_000)).toBe(true);
  });
});
