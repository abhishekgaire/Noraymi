import { describe, expect, it } from "vitest";
import { breakGlassHtml, breakGlassLines, wrap, type BreakGlassCard } from "./break-glass.js";

const card: BreakGlassCard = {
  venue: "West 4 Boho Karaoke",
  time_zone: "America/New_York",
  printed_at: "2026-09-26T02:41:00Z",
  ready: ["Abhishek G.", "Andy C."],
  not_ready: [],
};

describe("the break-glass card (M8-06)", () => {
  it("wraps at word boundaries to 32 columns", () => {
    const lines = wrap("Take cash. Write down the room or tab, the amount and the time.");
    expect(lines.every((l) => l.length <= 32)).toBe(true);
    expect(lines.join(" ")).toBe("Take cash. Write down the room or tab, the amount and the time.");
  });

  it("the short version names who's ready and says to take cash, in English then Spanish", () => {
    const lines = breakGlassLines(card);
    expect(lines.every((l) => l.length <= 32)).toBe(true);
    const sep = lines.indexOf("-".repeat(32));
    expect(sep).toBeGreaterThan(0);
    expect(lines.slice(0, sep).join(" ")).toContain("Take cash.");
    expect(lines.slice(sep).join(" ")).toContain("Cobra en efectivo.");
    expect(lines.filter((l) => l === "- Andy C.")).toHaveLength(2);
  });

  it("with nobody ready, says so and where to confirm them; names who isn't ready", () => {
    const none = { ...card, ready: [], not_ready: ["Andy C."] };
    const html = breakGlassHtml(none);
    expect(html).toContain("No manager is ready yet");
    expect(html).toContain("Not ready yet: Andy C.");
    expect(breakGlassLines(none).join(" ")).toContain("Admin → Payments");
  });

  it("escapes the venue's name and prints the time in the venue's time zone", () => {
    const html = breakGlassHtml({ ...card, venue: "A & <B>" });
    expect(html).toContain("A &#38; &#60;B&#62;");
    expect(html).toContain("10:41 PM");
  });
});
