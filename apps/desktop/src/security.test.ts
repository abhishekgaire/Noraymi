import { describe, expect, it } from "vitest";
import { allowedOriginsFrom, isAllowedUrl, isTrustedSender } from "./security.js";

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
