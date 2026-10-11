import { describe, expect, it } from "vitest";
import {
  addToSection,
  emptyPosLayout,
  posLayoutSectionsSchema,
  sectionPages,
  trimSection,
} from "./pos.js";

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
  it("refuses an item already there, and a section whose four pages are full", () => {
    expect(addToSection([a, ...Array(24).fill(null)], a)).toBeNull();
    expect(addToSection(Array(100).fill(a), b)).toBeNull();
  });
  it("grows a full section by a page, and nothing moves (K-12)", () => {
    const full = Array(25).fill(a);
    const out = addToSection(full, b)!;
    expect(out).toHaveLength(50);
    expect(out.slice(0, 25)).toEqual(full);
    expect(out[25]).toBe(b);
    expect(sectionPages(out).map((p) => p.length)).toEqual([25, 25]);
  });
  it("drops trailing empty pages but keeps the first", () => {
    expect(trimSection([a, ...Array(49).fill(null)])).toHaveLength(25);
    expect(trimSection(Array(50).fill(null))).toHaveLength(25);
    expect(trimSection([...Array(25).fill(null), b, ...Array(24).fill(null)])).toHaveLength(50);
  });
  it("has ten sections of whole pages of 25 slots, up to four", () => {
    expect(posLayoutSectionsSchema.safeParse(emptyPosLayout()).success).toBe(true);
    const short = { ...emptyPosLayout(), beer: [a] };
    expect(posLayoutSectionsSchema.safeParse(short).success).toBe(false);
    const two = { ...emptyPosLayout(), spirits: Array(50).fill(null) };
    expect(posLayoutSectionsSchema.safeParse(two).success).toBe(true);
    const odd = { ...emptyPosLayout(), spirits: Array(30).fill(null) };
    expect(posLayoutSectionsSchema.safeParse(odd).success).toBe(false);
    const five = { ...emptyPosLayout(), spirits: Array(125).fill(null) };
    expect(posLayoutSectionsSchema.safeParse(five).success).toBe(false);
  });
});
