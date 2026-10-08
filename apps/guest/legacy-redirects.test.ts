import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BOOKING_MOVED,
  LEGACY_PAGES,
  LEGACY_REDIRECTS,
  canonicalHost,
  legacyRedirect,
  normalizePath,
} from "./legacy-redirects";

/** True when the new site has a page at this path (app/<path>/page.tsx). */
const served = (url: string) => {
  const p = normalizePath(url.replace(/[?#].*$/, "") || "/");
  return existsSync(path.join(import.meta.dirname, "app", p, "page.tsx"));
};

describe("every old west4karaoke.com page answers (M9-09)", () => {
  it.each(LEGACY_PAGES)("%s lands on a page the new site serves", (url) => {
    const answer = legacyRedirect(url.replace(/\?.*$/, ""), false);
    if (answer) expect([301, 302]).toContain(answer.status);
    expect(served(answer?.to ?? url)).toBe(true);
  });

  it("every redirect row comes from the list and goes to a served page", () => {
    for (const [from, to] of Object.entries(LEGACY_REDIRECTS)) {
      expect(LEGACY_PAGES.map((u) => normalizePath(u.replace(/\?.*$/, "")))).toContain(from);
      expect(served(to)).toBe(true);
    }
  });

  it("the old booking page is a permanent redirect, whatever its case or trailing slash", () => {
    expect(legacyRedirect("/Reservation/", false)).toEqual({ to: "/book", status: 301 });
  });

  it("the old rooms page leaves a joined guest's room alone", () => {
    expect(legacyRedirect("/room", true)).toBeNull();
    expect(legacyRedirect("/room", false)).toEqual({ to: "/#rooms", status: 302 });
  });

  it("pages the new site serves itself aren't redirected", () => {
    for (const p of ["/", "/menu", "/book", "/b/abc", "/receipt/abc", "/v1/public/x"])
      expect(legacyRedirect(p, false)).toBeNull();
  });

  it("the old manage-booking page exists", () => {
    expect(served(BOOKING_MOVED)).toBe(true);
  });

  it("www goes to the bare host only when SITE_HOST names it", () => {
    expect(canonicalHost("www.west4karaoke.com", "west4karaoke.com")).toBe("west4karaoke.com");
    expect(canonicalHost("west4karaoke.com", "west4karaoke.com")).toBeNull();
    expect(canonicalHost("www.west4karaoke.com", undefined)).toBeNull();
  });
});
