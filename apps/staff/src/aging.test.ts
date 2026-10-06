import { describe, expect, it } from "vitest";
import { t } from "@west4/shared";
import { agingFromWire, agingSentence, agingTone, WEST4_AGING } from "./aging.js";

describe("order aging (M6-25)", () => {
  it("West 4's values read as the glossary's escalation sentence", () => {
    const s = agingSentence(agingFromWire(WEST4_AGING));
    expect(t("en", s.key, s.params)).toBe(
      "Ages on screen: amber at 2 min, pink at 4 when the manager on duty is told; bar phones at 30 s; a text or call at 6; chime as backup.",
    );
  });

  it("colors by the venue's times", () => {
    expect(agingTone(119, WEST4_AGING)).toBeNull();
    expect(agingTone(120, WEST4_AGING)).toBe("amber");
    expect(agingTone(90, { ...WEST4_AGING, amber_sec: 60 })).toBe("amber");
    expect(agingTone(240, WEST4_AGING)).toBe("pink");
  });

  it("leaves out the chime when it's off", () => {
    const s = agingSentence({ ...agingFromWire(WEST4_AGING), chime: false, amberSec: 90 });
    expect(t("en", s.key, s.params)).toContain("amber at 1.5 min");
    expect(t("en", s.key, s.params)).not.toContain("chime");
  });
});
