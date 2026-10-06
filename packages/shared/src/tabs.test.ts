import { describe, expect, it } from "vitest";
import {
  TAB_SETTLED,
  TAB_STATES,
  canMoveTab,
  tabConsentLine,
  roomCardConsentLine,
  tabNameFromCard,
  type TabState,
} from "./tabs.js";

/** A small seeded random source, so the property runs are the same every time. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Applies random moves from open, taking only those the machine allows. */
function walk(seed: number, steps: number): TabState[] {
  const r = rng(seed);
  let s: TabState = "open";
  const seen: TabState[] = [s];
  for (let i = 0; i < steps; i++) {
    const to = TAB_STATES[Math.floor(r() * TAB_STATES.length)]!;
    if (canMoveTab(s, to)) seen.push((s = to));
  }
  return seen;
}

describe("the tab state machine (Payment flows diagram)", () => {
  it("allows exactly the diagram's moves", () => {
    const allowed = TAB_STATES.flatMap((from) =>
      TAB_STATES.filter((to) => canMoveTab(from, to)).map((to) => `${from}→${to}`),
    );
    expect(allowed.sort()).toEqual(
      [
        "open→open",
        "open→tipping",
        "tipping→open",
        "tipping→captured",
        "open→awaiting_tip",
        "tipping→awaiting_tip",
        "awaiting_tip→captured",
        "open→walkout_captured",
        "open→closed",
        "tipping→capture_failed",
        "awaiting_tip→capture_failed",
        "open→capture_failed",
        "capture_failed→closed",
        "captured→open",
        "walkout_captured→open",
        "closed→open",
      ].sort(),
    );
  });

  it("on any sequence of events, a tab only leaves a settled state to reopen", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const seen = walk(seed, 40);
      for (let i = 1; i < seen.length; i++) {
        const [from, to] = [seen[i - 1]!, seen[i]!];
        if (TAB_SETTLED.includes(from)) expect(to).toBe("open");
        if (from === "capture_failed") expect(to).toBe("closed");
        expect(canMoveTab(from, to)).toBe(true);
      }
    }
  });

  it("on any sequence, awaiting_tip is reached only from open or tipping, and never goes back", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const seen = walk(seed, 40);
      seen.forEach((s, i) => {
        if (s === "awaiting_tip" && i > 0 && seen[i - 1] !== "awaiting_tip")
          expect(["open", "tipping"]).toContain(seen[i - 1]);
        if (i > 0 && seen[i - 1] === "awaiting_tip")
          expect(["captured", "capture_failed"]).toContain(s);
      });
    }
  });
});

describe("the consent line (Payment flows · The consent line)", () => {
  it("reads West 4's words exactly", () => {
    expect(tabConsentLine({ openingHoldCents: 5000, cutOffAt: "04:30" })).toBe(
      "We'll hold $50 on this card and add to it as you order. We charge your tab when you close out, or at 4:30 AM if it's still open. Add your tip on the reader.",
    );
  });

  it("reads another venue's own numbers", () => {
    expect(tabConsentLine({ openingHoldCents: 7550, cutOffAt: "02:00" })).toContain(
      "hold $75.50 on this card",
    );
    expect(tabConsentLine({ openingHoldCents: 100000, cutOffAt: "00:15" })).toContain(
      "hold $1,000 on this card and add to it as you order. We charge your tab when you close out, or at 12:15 AM",
    );
    expect(tabConsentLine({ openingHoldCents: 5000, cutOffAt: "23:45" })).toContain("11:45 PM");
  });
});

describe("the tab's name from a dip or swipe", () => {
  it("is the first name and the last initial", () => {
    expect(tabNameFromCard("JESS PARKER")).toBe("Jess P.");
    expect(tabNameFromCard("PARKER/JESS")).toBe("Jess P.");
    expect(tabNameFromCard("PARKER/JESS M")).toBe("Jess P.");
    expect(tabNameFromCard("Luis")).toBe("Luis");
  });
  it("is nothing for a tap or a phone", () => {
    expect(tabNameFromCard(null)).toBeNull();
    expect(tabNameFromCard("  ")).toBeNull();
    expect(tabNameFromCard("/")).toBeNull();
  });
});

describe("the room card consent line (M6-13)", () => {
  it("says the card is saved, nothing is charged now, and when it would be", () => {
    expect(roomCardConsentLine()).toBe(
      "We'll save this card for your room's bill. Nothing is charged now. We charge it only for what's left unpaid when you leave.",
    );
  });
});
