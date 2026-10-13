import { describe, expect, it } from "vitest";
import {
  DEFAULT_STAFF_URL,
  parseServerAddress,
  readServerFile,
  resolveStaffServer,
  serverFileContents,
  setupAction,
  setupPage,
} from "./server-address.js";

describe("parseServerAddress", () => {
  it("takes what a person types, and makes it https unless they said http", () => {
    expect(parseServerAddress("192.168.1.20:5173")).toBe("https://192.168.1.20:5173");
    expect(parseServerAddress("  https://192.168.1.20:5173/ ")).toBe("https://192.168.1.20:5173");
    expect(parseServerAddress("http://10.0.0.4:5173")).toBe("http://10.0.0.4:5173");
    expect(parseServerAddress("staff.west4.example")).toBe("https://staff.west4.example");
  });

  it("refuses anything that isn't a plain web address", () => {
    for (const bad of [
      "",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://a@192.168.1.20",
      "https://192.168.1.20/some/page",
      "https://192.168.1.20/?x=1",
      "not a url at all",
    ])
      expect(parseServerAddress(bad)).toBeNull();
  });
});

describe("resolveStaffServer", () => {
  it("prefers STAFF_URL, then server.json, then localhost", () => {
    const file = serverFileContents("https://192.168.1.20:5173");
    expect(resolveStaffServer({ STAFF_URL: "http://localhost:13173" }, file)).toEqual({
      url: "http://localhost:13173",
      from: "env",
    });
    expect(resolveStaffServer({}, file)).toEqual({
      url: "https://192.168.1.20:5173",
      from: "file",
    });
    expect(resolveStaffServer({}, null)).toEqual({ url: DEFAULT_STAFF_URL, from: "default" });
  });

  it("ignores a broken server.json", () => {
    expect(readServerFile("{")).toBeNull();
    expect(readServerFile('{"staffUrl": 5}')).toBeNull();
    expect(readServerFile('{"staffUrl": "javascript:alert(1)"}')).toBeNull();
    expect(resolveStaffServer({}, "{")).toEqual({ url: DEFAULT_STAFF_URL, from: "default" });
  });
});

describe("the setup screen", () => {
  it("says what was asked for, and nothing else counts", () => {
    expect(
      setupAction("https://west4-server-setup.invalid/save?address=192.168.1.20%3A5173"),
    ).toEqual({ kind: "save", address: "192.168.1.20:5173" });
    expect(setupAction("https://west4-server-setup.invalid/cancel")).toEqual({ kind: "cancel" });
    expect(setupAction("https://192.168.1.20:5173/save?address=x")).toBeNull();
    expect(setupAction("not a url")).toBeNull();
  });

  it("escapes the address it shows back", () => {
    const page = decodeURIComponent(
      setupPage({ current: '"><script>x</script>', error: true }).split(",")[1]!,
    );
    expect(page).not.toContain("<script>x");
    expect(page).toContain("&quot;&gt;&lt;script&gt;");
    expect(page).toContain("Dirección del servidor");
  });
});
