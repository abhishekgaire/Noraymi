import { describe, expect, it } from "vitest";
import {
  CELLULAR_FEE_CENTS,
  SUPPORTED_READERS,
  configurationParams,
  hasCellular,
  readerModel,
} from "./terminal.js";
import { formEncode } from "./client.js";

describe("the Terminal Configuration from pay.tipScreen", () => {
  it("is 18, 20 and 22%, $1, $2 and $3 under $10, with cellular on", () => {
    const params = configurationParams({
      on: true,
      pcts: [18, 20, 22],
      fixedCents: [100, 200, 300] as never,
      smartThresholdCents: 1000 as never,
    });
    expect(Object.fromEntries(formEncode(params))).toEqual({
      "tipping[usd][percentages][0]": "18",
      "tipping[usd][percentages][1]": "20",
      "tipping[usd][percentages][2]": "22",
      "tipping[usd][smart_tip_threshold]": "1000",
      "tipping[usd][fixed_amounts][0]": "100",
      "tipping[usd][fixed_amounts][1]": "200",
      "tipping[usd][fixed_amounts][2]": "300",
      "cellular[enabled]": "true",
    });
  });

  it("offers the S710, S700 and WisePOS E, never the M2, and only the S710 has cellular at $10 a month", () => {
    expect(SUPPORTED_READERS).toEqual(["stripe_s710", "stripe_s700", "bbpos_wisepos_e"]);
    expect(SUPPORTED_READERS).not.toContain("stripe_m2");
    expect(SUPPORTED_READERS.filter(hasCellular)).toEqual(["stripe_s710"]);
    expect(CELLULAR_FEE_CENTS).toBe(1000);
  });

  it("counts a sandbox's simulated reader as the model it simulates, never in live mode", () => {
    expect(readerModel("simulated_stripe_s710", false)).toBe("stripe_s710");
    expect(readerModel("simulated_stripe_s710", true)).toBeNull();
    expect(readerModel("stripe_s710", true)).toBe("stripe_s710");
    expect(readerModel("simulated_stripe_m2", false)).toBeNull();
    expect(readerModel("stripe_m2", true)).toBeNull();
  });
});
