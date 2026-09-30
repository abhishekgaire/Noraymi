import { describe, expect, it } from "vitest";
import { assertAllowed, isAllowed, parseAllowList } from "./policy.js";
import { loadEmailSettings } from "./settings.js";

describe("the staging allow-list", () => {
  const list = parseAllowList(" Andy@Example.com, @west4.nyc ,, ");

  it("matches full addresses and whole domains, ignoring case", () => {
    expect(isAllowed(list, "andy@example.com")).toBe(true);
    expect(isAllowed(list, "ANDY@EXAMPLE.COM")).toBe(true);
    expect(isAllowed(list, "diego@west4.nyc")).toBe(true);
    expect(isAllowed(list, "diego@notwest4.nyc")).toBe(false);
    expect(isAllowed(list, "maya@example.com")).toBe(false);
  });

  it("an empty list allows nothing; no list allows everything", () => {
    expect(isAllowed(parseAllowList(""), "andy@example.com")).toBe(false);
    expect(isAllowed(null, "anyone@anywhere.test")).toBe(true);
  });

  it("refuses with a reason that names the domain, not the address", () => {
    expect(() => assertAllowed(list, "maya.chen@gmail.com")).toThrow(
      /outside the staging allow-list/,
    );
    expect(() => assertAllowed(list, "maya.chen@gmail.com")).not.toThrow(/maya/);
  });
});

describe("email settings", () => {
  it("locally, default to the mail catcher with no allow-list", () => {
    const s = loadEmailSettings("local", {});
    expect(s.smtpUrl).toBe("smtp://localhost:1025");
    expect(s.allowList).toBeNull();
  });

  it("on staging, the allow-list always exists, empty when unset", () => {
    const s = loadEmailSettings("staging", { SMTP_URL: "smtp://relay", EMAIL_FROM: "a@b.c" });
    expect(s.allowList).toEqual({ addresses: new Set(), domains: new Set() });
    const s2 = loadEmailSettings("staging", {
      SMTP_URL: "smtp://relay",
      EMAIL_FROM: "a@b.c",
      EMAIL_ALLOW_LIST: "@west4.nyc",
    });
    expect(isAllowed(s2.allowList, "andy@west4.nyc")).toBe(true);
  });

  it("outside local, SMTP_URL and EMAIL_FROM must be set", () => {
    expect(() => loadEmailSettings("production", {})).toThrow(/SMTP_URL/);
    expect(() => loadEmailSettings("production", { SMTP_URL: "smtp://relay" })).toThrow(
      /EMAIL_FROM/,
    );
    expect(
      loadEmailSettings("production", { SMTP_URL: "smtp://relay", EMAIL_FROM: "a@b.c" }).allowList,
    ).toBeNull();
  });
});
