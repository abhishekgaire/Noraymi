import { describe, expect, it } from "vitest";
import { addToSection, emptyPosLayout, posLayoutSectionsSchema } from "./pos.js";

const a = "00000000-0000-4000-8000-00000000000a";
const b = "00000000-0000-4000-8000-00000000000b";
const c = "00000000-0000-4000-8000-00000000000c";

describe("bar POS layouts (M6-01)", () => {
  it("an added item takes the first empty slot and nothing else moves", () => {
    const slots = [a, null, b, null, ...Array(21).fill(null)];
    const out = addToSection(slots, c)!;
    expect(out.slice(0, 4)).toEqual([a, c, b, null]);
    expect(out.filter((x) => x !== null)).toHaveLength(3);
  });
  it("refuses a full section or an item already there", () => {
    expect(addToSection(Array(25).fill(a), b)).toBeNull();
    expect(addToSection([a, ...Array(24).fill(null)], a)).toBeNull();
  });
  it("has ten sections of 25 slots", () => {
    expect(posLayoutSectionsSchema.safeParse(emptyPosLayout()).success).toBe(true);
    const short = { ...emptyPosLayout(), beer: [a] };
    expect(posLayoutSectionsSchema.safeParse(short).success).toBe(false);
  });
});
