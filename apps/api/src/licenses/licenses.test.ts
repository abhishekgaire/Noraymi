import { describe, expect, it } from "vitest";
import { render } from "../email/templates.js";
import { reminderDue } from "./licenses.js";

describe("license reminder windows (M8-09)", () => {
  it("reminds at 60, 30 and 7 days, each once, and never before 60", () => {
    expect(reminderDue(61, null)).toBeNull();
    expect(reminderDue(60, null)).toBe(60);
    expect(reminderDue(45, 60)).toBeNull();
    expect(reminderDue(30, 60)).toBe(30);
    expect(reminderDue(30, 30)).toBeNull();
    expect(reminderDue(8, 30)).toBeNull();
    expect(reminderDue(7, 30)).toBe(7);
    expect(reminderDue(1, 7)).toBeNull();
  });

  it("a license entered late gets only the narrowest window it's in; an expired one still gets the 7-day reminder once", () => {
    expect(reminderDue(20, null)).toBe(30);
    expect(reminderDue(3, null)).toBe(7);
    expect(reminderDue(-5, null)).toBe(7);
    expect(reminderDue(-5, 7)).toBeNull();
  });

  it("the email names the license, its number and date, in English and Spanish", () => {
    const data = {
      venueName: "Test Venue",
      kind: "gmr" as const,
      number: "N-1",
      expiresOn: "2026-10-25",
      daysLeft: 30,
    };
    const en = render("license_reminder", "en", data);
    expect(en.subject).toBe("GMR license at Test Venue expires October 25, 2026");
    expect(en.text).toContain("The GMR license N-1 at Test Venue expires on October 25, 2026.");
    const es = render("license_reminder", "es", { ...data, number: "" });
    expect(es.subject).toBe("La licencia de GMR en Test Venue vence el 25 de octubre de 2026");
    expect(es.text).toContain("Días restantes: 30.");
    expect(es.text).not.toContain("N-1");
  });
});
