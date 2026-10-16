import { describe, expect, it } from "vitest";
import { allowedOriginsFrom, isAllowedUrl, isTrustedSender, screenWindowFor } from "./security.js";

describe("the desktop app's walls", () => {
  const allowed = allowedOriginsFrom({
    STAFF_URL: "https://staff.west4.example",
    API_URL: "https://api.west4.example",
  });

  it("lists our hostnames from the environment, with a local default", () => {
    expect([...allowed]).toEqual(["https://staff.west4.example", "https://api.west4.example"]);
    expect([...allowedOriginsFrom({})]).toEqual(["http://localhost:5173"]);
  });

  it("lets the window show our pages and nothing else", () => {
    expect(isAllowedUrl("https://staff.west4.example/tonight", allowed)).toBe(true);
    expect(isAllowedUrl("https://api.west4.example/v1/health", allowed)).toBe(true);
    for (const url of [
      "https://example.com/",
      "http://staff.west4.example/",
      "https://staff.west4.example.evil.com/",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<script>",
      "not a url",
    ]) {
      expect(isAllowedUrl(url, allowed), url).toBe(false);
    }
  });

  it("takes an IPC message only from the main frame of one of our pages", () => {
    expect(
      isTrustedSender({ url: "https://staff.west4.example/bar", isMainFrame: true }, allowed),
    ).toBe(true);
    expect(
      isTrustedSender({ url: "https://staff.west4.example/bar", isMainFrame: false }, allowed),
    ).toBe(false);
    expect(isTrustedSender({ url: "https://example.com/", isMainFrame: true }, allowed)).toBe(
      false,
    );
    expect(isTrustedSender({ url: "data:text/html,x", isMainFrame: true }, allowed)).toBe(false);
    expect(isTrustedSender(null, allowed)).toBe(false);
  });
});

describe("the staff window", () => {
  it("is sandboxed and never throttled in the background, so the chime plays behind other windows (M3-16)", async () => {
    const { staffWebPreferences } = await import("./security.js");
    expect(staffWebPreferences("/app/preload.cjs")).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    });
  });

  it("opens the guest screen (on the second monitor) and the kitchen screen in windows of their own, nothing else (P-18)", () => {
    const allowed = allowedOriginsFrom({ STAFF_URL: "https://staff.west4.example" });
    expect(screenWindowFor("https://staff.west4.example/guest-screen", allowed)).toEqual({
      path: "/guest-screen",
      secondMonitor: true,
    });
    expect(screenWindowFor("https://staff.west4.example/kitchen-screen", allowed)).toEqual({
      path: "/kitchen-screen",
      secondMonitor: false,
    });
    expect(screenWindowFor("https://staff.west4.example/bar", allowed)).toBeNull();
    expect(screenWindowFor("https://evil.example/guest-screen", allowed)).toBeNull();
    expect(screenWindowFor("https://user:pw@staff.west4.example/guest-screen", allowed)).toBeNull();
    expect(screenWindowFor("javascript:alert(1)", allowed)).toBeNull();
  });
});
