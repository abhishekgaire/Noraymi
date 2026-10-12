import { describe, expect, it } from "vitest";
import { addressOutsideNewYork, venueProfileSchema } from "./venue-profile.js";

const astoria = {
  line1: "31-18 Steinway St",
  city: "Astoria",
  state: "ny",
  postal_code: "11103",
};

describe("the venue's address (O-03)", () => {
  it("takes a New York City address in any borough", () => {
    for (const zip of ["10012", "11103", "11211", "10451", "10301", "11101"])
      expect(addressOutsideNewYork({ ...astoria, state: "NY", postal_code: zip })).toBeNull();
  });

  it("refuses an address outside New York City, or outside the state", () => {
    expect(addressOutsideNewYork({ ...astoria, state: "NY", postal_code: "14201" })).toBe(
      "outside_new_york",
    );
    expect(addressOutsideNewYork({ ...astoria, state: "NJ", postal_code: "07030" })).toBe(
      "outside_new_york",
    );
  });

  it("normalises the state and allows an address not entered yet", () => {
    const parsed = venueProfileSchema.parse({
      name: "Sing Sing",
      legal_name: "Sing Sing Karaoke LLC",
      address: astoria,
    });
    expect(parsed.address?.state).toBe("NY");
    expect(
      venueProfileSchema.safeParse({ name: "Sing Sing", legal_name: "X", address: null }).success,
    ).toBe(true);
    expect(venueProfileSchema.safeParse({ name: "", legal_name: "X", address: null }).success).toBe(
      false,
    );
  });

  it("has no EIN field", () => {
    expect(
      venueProfileSchema.safeParse({ name: "A", legal_name: "B", address: null, ein: "12-3456789" })
        .success,
    ).toBe(false);
  });
});
