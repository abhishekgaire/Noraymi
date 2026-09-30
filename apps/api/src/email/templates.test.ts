import { describe, expect, it } from "vitest";
import { locales } from "@west4/shared";
import { emailJobPayload } from "../jobs/send-email.js";
import { fill, render, templateNames, templateSchemas } from "./templates.js";

const invite = {
  venueName: "West 4 Boho Karaoke",
  inviteeName: "Diego",
  inviterName: "Andy",
  inviteUrl: "https://staff.west4.test/invite/abc123",
  expiresHours: 48,
};

describe("email templates", () => {
  it.each(locales)("the invite renders in %s with every slot filled", (locale) => {
    const mail = render("invite", locale, invite);
    for (const part of [mail.subject, mail.text, mail.html]) {
      expect(part).not.toMatch(/\{\w+\}/);
      expect(part).toContain("West 4 Boho Karaoke");
    }
    expect(mail.text).toContain(invite.inviteUrl);
    expect(mail.html).toContain(`href="${invite.inviteUrl}"`);
    expect(mail.text).toContain("Diego");
    expect(mail.text).toContain("Andy");
  });

  it.each(locales)(
    "the owner recovery notice renders in %s, by code and by a second owner",
    (locale) => {
      const base = {
        venueName: "West 4 Boho Karaoke",
        name: "Andy",
        ownerName: "Abhishek G.",
        readyAt: "Sunday, September 27, 2026 at 10:41 PM",
      };
      const byCode = render("owner_recovery_notice", locale, { ...base, method: "recovery_code" });
      const bySecond = render("owner_recovery_notice", locale, {
        ...base,
        method: "second_owner",
        requesterName: "Priya S.",
      });
      for (const mail of [byCode, bySecond]) {
        for (const part of [mail.subject, mail.text, mail.html]) {
          expect(part).not.toMatch(/\{\w+\}/);
          expect(part).toContain("West 4 Boho Karaoke");
        }
        expect(mail.text).toContain("Abhishek G.");
        expect(mail.text).toContain(base.readyAt);
        expect(mail.text).toContain("48");
      }
      expect(byCode.text).not.toContain("Priya");
      expect(bySecond.text).toContain("Priya S.");
      // The notice never carries a code, a token or a link to act on.
      expect(byCode.text).not.toMatch(/https?:\/\//);
    },
  );

  it("no template takes a PIN, a password or a secret, and a payload that carries one is rejected", () => {
    for (const name of templateNames) {
      const keys = Object.keys(templateSchemas[name].shape);
      expect(keys.filter((k) => /pin|secret|password|hash/i.test(k))).toEqual([]);
      // The one-time sign-in code (M1-19) is the only code an email carries, on its own template.
      expect(keys.filter((k) => /code/i.test(k))).toEqual(name === "sign_in_code" ? ["code"] : []);
    }
    const good = { template: "invite", to: "diego@example.com", locale: "es", data: invite };
    expect(emailJobPayload.safeParse(good).success).toBe(true);
    const withPin = { ...good, data: { ...invite, pin: "2580" } };
    expect(emailJobPayload.safeParse(withPin).success).toBe(false);
    const topLevelPin = { ...good, pin: "2580" };
    expect(emailJobPayload.safeParse(topLevelPin).success).toBe(false);
    expect(emailJobPayload.safeParse({ ...good, to: "not-an-address" }).success).toBe(false);
  });

  it("escapes HTML in names and leaves an unknown slot visible", () => {
    const mail = render("invite", "en", { ...invite, inviteeName: "<b>Diego</b>" });
    expect(mail.html).toContain("&lt;b&gt;Diego&lt;/b&gt;");
    expect(mail.text).toContain("<b>Diego</b>");
    expect(fill("Hi {name}, {missing}", { name: "Ana" })).toBe("Hi Ana, {missing}");
  });
});
