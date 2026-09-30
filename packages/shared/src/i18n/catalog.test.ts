import { describe, expect, it } from "vitest";
import { catalogs, locales, t } from "./index.js";

describe("i18n catalogs", () => {
  it("has the same keys in every language", () => {
    const keysOf = (locale: (typeof locales)[number]) => Object.keys(catalogs[locale]).sort();
    for (const locale of locales) {
      expect(keysOf(locale)).toEqual(keysOf("en"));
    }
  });

  it("has no empty strings", () => {
    for (const locale of locales) {
      for (const [key, value] of Object.entries(catalogs[locale])) {
        expect(value.trim(), `${locale}:${key}`).not.toBe("");
      }
    }
  });

  it("looks a string up by locale", () => {
    expect(t("en", "app.console.name")).toBe("Console");
    expect(t("es", "app.console.name")).toBe("Consola");
  });
});
