import { describe, expect, it } from "vitest";
import { catalogs, locales, tn } from "./index.js";

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
    // The escalation sentence (glossary): Admin → Features describes Bar screen & tickets with it.
    expect(catalogs.en["module.bar_screen.description"]).toBe(
      "Ages on screen: amber at 2 min, pink at 4 when the manager on duty is told; bar phones at 30 s; a text or call at 6; chime as backup.",
    );
  });

  it('never describes escalation as "ring the bar until accepted" (the alarm toggle is gone)', () => {
    for (const locale of ["en", "es"] as const) {
      for (const [key, value] of Object.entries(catalogs[locale])) {
        expect(value, `${locale}.${key}`).not.toMatch(
          /ring(s)? the bar until|hasta que (alguien )?acepte/i,
        );
      }
    }
  });
});

/** One word for each thing (U-20, D133; glossary · Say this, not that). */
describe("one word for each thing", () => {
  it('keeps "Alerts" for the board: the phone tab is Phone alerts, Admin is Sounds & rules', () => {
    expect(catalogs.en["tabs.alerts"]).toBe("Phone alerts");
    expect(catalogs.es["tabs.alerts"]).toBe("Avisos del teléfono");
    expect(catalogs.en["admin.section.alerts"]).toBe("Sounds & rules");
    expect(catalogs.en["alert.title"]).toBe("Alerts");
  });

  it('says "check" on staff screens; the printed slip still reads BILL', () => {
    expect(catalogs.en["printBill.button"]).toBe("Print the check");
    expect(catalogs.en["printBill.title"]).toBe("BILL");
    expect(catalogs.es["printBill.title"]).toBe("CUENTA");
  });

  it("says feature and state rules to owners, never module or rule pack", () => {
    for (const locale of locales) {
      for (const [key, value] of Object.entries(catalogs[locale])) {
        expect(value.replace(/\{\w+\}/g, ""), `${locale}:${key}`).not.toMatch(
          /\bmodules?\b|rule pack|módulo|paquete de reglas/i,
        );
      }
    }
  });

  it("has one cleaning word: Needs cleaning and Mark clean", () => {
    for (const value of Object.values(catalogs.en)) expect(value).not.toMatch(/needs? a wipe/i);
    expect(catalogs.en["cleaning.title"]).toBe("Needs cleaning");
    expect(catalogs.en["phone.kind.cleaning"]).toBe("Needs cleaning");
    expect(catalogs.en["cleaning.markClean"]).toBe("Mark clean");
  });

  it('counts the bell in Spanish plurals: "1 nuevo", "2 nuevos"', () => {
    expect(tn("es", "bell.open", 1)).toBe("Campana · 1 nuevo");
    expect(tn("es", "bell.open", 2)).toBe("Campana · 2 nuevos");
    expect(tn("en", "bell.open", 0)).toBe("Bell · 0 new");
  });

  it("says Asked to wait in the bell, Send 3 at the bar, and the top bar's night", () => {
    expect(catalogs.en["bell.item.orderHeld"]).toBe("{room}'s order · Asked to wait");
    expect(catalogs.en["drinks.sendAtBar"]).toBe("Send {count}");
    expect(catalogs.en["drinks.sentOnTab"]).toBe("Sent · on {name}'s tab");
    expect(catalogs.en["shell.night.5"]).toBe("Fri night");
  });
});
