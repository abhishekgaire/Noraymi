import { describe, expect, it } from "vitest";
import { allInCents, roomFor, type SiteTier } from "./site.js";

const tiers: SiteTier[] = [
  { tier: "small", rooms: 5, capacityMin: 3, capacityMax: 6, vip: false },
  { tier: "medium", rooms: 5, capacityMin: 6, capacityMax: 12, vip: false },
  { tier: "large", rooms: 3, capacityMin: 12, capacityMax: 20, vip: false },
  { tier: "vip", rooms: 1, capacityMin: 20, capacityMax: 40, vip: true },
];
const west4 = { tiers, perPersonCents: 1000, vip: { hourlyCents: 25000, fromGuests: 20 } };

describe("the guest site's numbers (M5-01)", () => {
  it("all in: $10.00 is $12.89 with a 20% gratuity and 8.875% tax on the price; the VIP room's $250.00 is $322.19", () => {
    expect(allInCents(1000, "8.875", 20)).toBe(1289);
    expect(allInCents(25000, "8.875", 20)).toBe(32219);
  });
  it("3 guests on a Friday fit a small room billed for 4: $40.00 an hour", () => {
    expect(roomFor({ ...west4, guests: 3, minGuestsTonight: 4 })).toMatchObject({
      tier: { tier: "small" },
      billableGuests: 4,
      hourlyCents: 4000,
    });
  });
  it("a weeknight bills 3 for 3; 12 fit a medium room; 20 take the VIP room at $250.00 flat; 41 fit nowhere", () => {
    expect(roomFor({ ...west4, guests: 3, minGuestsTonight: 3 })!.hourlyCents).toBe(3000);
    expect(roomFor({ ...west4, guests: 12, minGuestsTonight: 4 })!.tier.tier).toBe("medium");
    expect(roomFor({ ...west4, guests: 20, minGuestsTonight: 4 })).toMatchObject({
      tier: { tier: "vip" },
      hourlyCents: 25000,
    });
    expect(roomFor({ ...west4, guests: 19, minGuestsTonight: 4 })).toMatchObject({
      tier: { tier: "large" },
      hourlyCents: 19000,
    });
    expect(roomFor({ ...west4, guests: 41, minGuestsTonight: 4 })).toBeNull();
  });
});
