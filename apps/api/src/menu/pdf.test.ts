import { describe, expect, it } from "vitest";
import { menuHtml } from "./pdf.js";

/** The allergy notice on the menu PDF (K-08): the owner's words from Admin → Kitchen, both languages. */
const TEST_NOTICE = { en: "TEST ONLY · allergy <notice>", es: "SOLO PRUEBA · aviso de alergias" };
const categories = [
  {
    name: "TEST Wings",
    items: [
      {
        name: "TEST wings",
        description: null,
        variants: [{ name: "Regular", price_cents: 1200 }],
        groups: [],
      },
    ],
  },
];

describe("menuHtml and the allergy notice", () => {
  it("prints the notice at the top, English then Spanish, escaped", () => {
    const html = menuHtml("West 4", categories, [], TEST_NOTICE);
    expect(html).toContain(
      '<aside class="allergy" aria-label="Allergy notice"><p>TEST ONLY · allergy &#60;notice&#62;</p><p lang="es">SOLO PRUEBA · aviso de alergias</p></aside>',
    );
    expect(html.indexOf("allergy &#60;notice")).toBeLessThan(html.indexOf("TEST Wings"));
  });

  it("prints no notice while it isn't shown (module off or not set)", () => {
    expect(menuHtml("West 4", categories, [], null)).not.toContain('class="allergy"');
    expect(menuHtml("West 4", categories)).not.toContain('class="allergy"');
  });
});
