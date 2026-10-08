import { describe, expect, it } from "vitest";
import { catalogs } from "./index.js";
import { FIXED_SENTENCES } from "./fixed-sentences.js";

const en = catalogs.en as Readonly<Record<string, string>>;
const es = catalogs.es as Readonly<Record<string, string>>;

describe("each fixed sentence reads the same in Spanish on every screen (M9-12)", () => {
  it.each(FIXED_SENTENCES)("$en", ({ en: sentence, es: spanish }) => {
    const keys = Object.keys(en).filter((k) => en[k]!.includes(sentence));
    expect(keys.length, `"${sentence}" is in no catalog string`).toBeGreaterThan(0);
    for (const k of keys) {
      if (en[k] === sentence) expect(es[k], k).toBe(spanish);
      else expect(es[k], `${k} quotes "${sentence}"`).toContain(spanish);
    }
  });
});
