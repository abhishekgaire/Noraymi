import { describe, expect, it } from "vitest";
import { loadTextSettings } from "./settings.js";

/** T-04 (D123): no Twilio account of ours is needed anywhere; our own pages text only with PAGING_TWILIO_*. */
describe("our own paging texts", () => {
  it("are off without PAGING_TWILIO_* on every server but local, where they're logged", () => {
    expect(loadTextSettings("production", {}).mode).toBe("off");
    expect(loadTextSettings("staging", {}).mode).toBe("off");
    expect(loadTextSettings("local", {}).mode).toBe("log");
  });

  it("never read the old platform TWILIO_* variables", () => {
    const old = {
      TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`,
      TWILIO_AUTH_TOKEN: "x".repeat(32),
      TWILIO_FROM_NUMBER: "+12125550100",
    };
    expect(loadTextSettings("production", old).mode).toBe("off");
  });

  it("text our on-call responders when all three PAGING_TWILIO_* are set", () => {
    const s = loadTextSettings("production", {
      PAGING_TWILIO_ACCOUNT_SID: `AC${"2".repeat(32)}`,
      PAGING_TWILIO_AUTH_TOKEN: "y".repeat(32),
      PAGING_TWILIO_FROM_NUMBER: "+12125550101",
    });
    expect(s).toMatchObject({ mode: "twilio", fromNumber: "+12125550101" });
  });
});
