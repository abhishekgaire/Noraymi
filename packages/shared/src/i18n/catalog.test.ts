import { describe, expect, it } from "vitest";
import { SEED_NOW } from "../clock.js";
import {
  catalogs,
  formatDate,
  formatMoney,
  formatNumber,
  formatTime,
  locales,
  t,
  tn,
} from "./index.js";

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

  it("uses the same {placeholders} in every language", () => {
    const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [key, english] of Object.entries(catalogs.en)) {
      expect(holes(catalogs.es[key as keyof typeof catalogs.es]), key).toEqual(holes(english));
    }
  });

  it("looks a string up by locale", () => {
    expect(t("en", "app.console.name")).toBe("Console");
    expect(t("es", "app.console.name")).toBe("Consola");
  });

  it("fills placeholders, writing numbers the language's way", () => {
    expect(t("en", "signIn.codeSent", { email: "andy@example.com" })).toBe(
      "We sent a code to andy@example.com",
    );
    expect(t("es", "shell.signedInAs", { name: "Andy C.", role: "Gerente" })).toBe(
      "Andy C. · Gerente",
    );
    // Spanish here is es-US: a US venue groups thousands with a comma in both languages.
    expect(t("en", "email.invite.expires", { hours: 1234 })).toContain("1,234");
    expect(t("es", "email.invite.expires", { hours: 1234 })).toContain("1,234");
  });

  it("picks the plural form by the language's rules", () => {
    expect(tn("en", "count.roomsOpen", 1)).toBe("1 room open");
    expect(tn("en", "count.roomsOpen", 0)).toBe("0 rooms open");
    expect(tn("en", "count.roomsOpen", 12)).toBe("12 rooms open");
    expect(tn("es", "count.roomsOpen", 1)).toBe("1 sala abierta");
    expect(tn("es", "count.roomsOpen", 12)).toBe("12 salas abiertas");
  });

  it("formats money from integer cents, never through a float", () => {
    expect(formatMoney("en", 61860)).toBe("$618.60");
    expect(formatMoney("es", 61860)).toBe("$618.60");
    expect(formatMoney("en", 5)).toBe("$0.05");
    expect(formatMoney("en", -12000)).toBe("-$120.00");
    expect(formatMoney("en", 123456789)).toBe("$1,234,567.89");
    expect(() => formatMoney("en", 1.5)).toThrow(TypeError);
    expect(formatNumber("en", 1234.5)).toBe("1,234.5");
    expect(formatNumber("es", 1234.5)).toBe("1,234.5");
  });

  it("writes the seed's 10:41 PM on the venue's clock in each language", () => {
    expect(formatTime("en", SEED_NOW, "America/New_York")).toBe("10:41 PM");
    expect(formatTime("es", SEED_NOW, "America/New_York")).toMatch(/^10:41\s?p\.\s?m\.$/);
    expect(formatTime("en", "2026-09-26T02:41:00Z", "America/Los_Angeles")).toBe("7:41 PM");
    expect(formatDate("en", "2026-09-25")).toBe("Fri, Sep 25");
    expect(formatDate("es", "2026-09-25")).toMatch(/^vie/);
  });
});
