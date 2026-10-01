import { describe, expect, it } from "vitest";
import { catalogs, locales } from "./index.js";

/**
 * The fixed sentences (glossary · Say this, not that; M1-26). No staff screen
 * says "name and PIN" without "badge or", "Lock" is never "Lock the iPad",
 * and the PIN-again line is the spec's exact words.
 */
describe("the words on screen", () => {
  it('never says "name and PIN" without "badge or"', () => {
    const phrase = { en: /name and PIN/i, es: /nombre y PIN/i };
    const badge = { en: /badge or/i, es: /tarjeta o/i };
    for (const locale of locales) {
      for (const [key, value] of Object.entries(catalogs[locale])) {
        if (phrase[locale].test(value)) expect(value, `${locale}:${key}`).toMatch(badge[locale]);
      }
    }
  });

  it('says "Lock", never "Lock the iPad"', () => {
    expect(catalogs.en["menu.lock"]).toBe("Lock");
    for (const value of Object.values(catalogs.en)) expect(value).not.toMatch(/Lock the iPad/);
  });

  it("carries the spec's fixed sentences word for word", () => {
    expect(catalogs.en["signIn.pinAgainRule"]).toBe(
      "Refunds, cash counts and no-sale ask for the PIN again; Admin needs a passkey",
    );
    expect(catalogs.en["admin.needsPasskeyPhone"]).toBe(
      "Admin needs your passkey. Open it in the desktop app or in a browser.",
    );
    expect(catalogs.en["signIn.noBadge"]).toBe("No badge? Tap your name, then your PIN");
  });
});
