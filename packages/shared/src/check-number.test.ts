import { describe, expect, it } from "vitest";
import { checkNumberLabel, trainingNumber } from "./check-number.js";

describe("check numbers (M7-03)", () => {
  it("shows a live check by its number and a practice check as T- and four digits", () => {
    expect(checkNumberLabel(1042)).toBe("1042");
    expect(checkNumberLabel(12, true)).toBe("T-0012");
    expect(trainingNumber(1)).toBe("T-0001");
    expect(trainingNumber(12345)).toBe("T-12345");
  });
});
