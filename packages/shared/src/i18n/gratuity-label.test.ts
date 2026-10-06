import { describe, expect, it } from "vitest";
import { newYorkCounty } from "../rule-pack.js";
import { catalogs } from "./index.js";

/**
 * GA-M2 (M7-20): "Gratuity" is the one label for the gratuity on every screen, receipt, report and
 * export. No string calls it a service charge, a service fee or an auto-grat, and the label the
 * receipts, reports and exports print comes from the rule pack's `gratuity.label`.
 */
describe("the gratuity's one label", () => {
  it("never calls the gratuity anything else", () => {
    for (const [key, value] of Object.entries(catalogs.en))
      expect(value, `en:${key}`).not.toMatch(/service charge|service fee|auto-?grat|\bgrat\b/i);
    for (const [key, value] of Object.entries(catalogs.es))
      expect(value, `es:${key}`).not.toMatch(/cargo por servicio|tarifa de servicio/i);
  });

  it('reads "Gratuity" where a figure is labelled, and the rule pack says the same', () => {
    expect(newYorkCounty.gratuity.label).toBe("Gratuity");
    for (const key of ["myTips.gratuity"] as const) expect(catalogs.en[key]).toBe("Gratuity");
    for (const [key, value] of Object.entries(catalogs.en))
      if (/gratuity/i.test(value)) expect(value, `en:${key}`).toMatch(/Gratuity|gratuity/);
  });
});
