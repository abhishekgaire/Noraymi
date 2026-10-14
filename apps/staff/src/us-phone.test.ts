import { describe, expect, it } from "vitest";
import { usE164 } from "./us-phone.js";

describe("usE164", () => {
  it("reads a US mobile typed any way", () => {
    for (const typed of [
      "(929) 739-7310",
      "929-739-7310",
      "+1 929 739 7310",
      "19297397310",
      "+19297397310",
    ])
      expect(usE164(typed)).toBe("+19297397310");
  });
  it("refuses what isn't a US number", () => {
    for (const typed of ["", "739-7310", "(129) 739-7310", "+44 20 7946 0958"])
      expect(usE164(typed)).toBeNull();
  });
});
