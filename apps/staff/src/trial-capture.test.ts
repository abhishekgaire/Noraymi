import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { flushTrial, labelOf, startTrialCapture, trialBuffer, trialMark } from "./trial-capture.js";

/** A control as the capture sees it: closest(), its aria-label and its text. */
const control = (attrs: { aria?: string; text?: string; tappable?: boolean }) => {
  const el = {
    closest: () => (attrs.tappable === false ? null : el),
    getAttribute: (name: string) => (name === "aria-label" ? (attrs.aria ?? null) : null),
    textContent: attrs.text ?? "",
  };
  return el as unknown as EventTarget;
};

beforeAll(() => {
  // No DOM in these tests: the document is a plain event target.
  (globalThis as { document?: unknown }).document ??= new EventTarget();
});

describe("the staff trial's capture (M9-11)", () => {
  let stop: (() => void) | null = null;
  afterEach(() => {
    stop?.();
    stop = null;
  });

  it("keeps nothing until the shell starts it, which it does only in training", () => {
    trialMark("tap", "Pay");
    expect(trialBuffer()).toHaveLength(0);
  });

  it("names a tap by the button's own words, one line, at most 80 characters", () => {
    expect(labelOf(control({ aria: "Repeat round", text: "↻" }))).toBe("Repeat round");
    expect(labelOf(control({ text: "  Close\n    tab " }))).toBe("Close tab");
    expect(labelOf(control({ text: "x", tappable: false }))).toBeUndefined();
    expect(labelOf(control({ text: "a".repeat(100) }))).toHaveLength(80);
    expect(labelOf(null)).toBeUndefined();
  });

  it("captures taps and errors while running and sends them, 200 at a time", async () => {
    const post = vi.fn().mockResolvedValue({});
    stop = startTrialCapture("venue-a", post);
    document.dispatchEvent(new Event("pointerdown"));
    trialMark("error", "forbidden");
    for (let i = 0; i < 250; i++) trialMark("tap", "Pay");
    expect(trialBuffer()[0]).toMatchObject({ kind: "tap" });
    await flushTrial(post);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0]![0]).toBe("venue-a");
    expect(post.mock.calls[0]![1]).toHaveLength(200);
    expect(post.mock.calls[0]![1][1]).toMatchObject({ kind: "error", label: "forbidden" });
    expect(trialBuffer()).toHaveLength(0);
  });

  it("holds a badge take-over marked between two captures for the next one", () => {
    trialMark("badge");
    trialMark("signed_in");
    stop = startTrialCapture("venue-a", vi.fn().mockResolvedValue({}));
    expect(trialBuffer().map((e) => e.kind)).toEqual(["badge", "signed_in"]);
  });
});
