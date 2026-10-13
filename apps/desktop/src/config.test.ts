import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { desktopUrls } from "./config.js";

describe("the packaged app's addresses (W-01)", () => {
  it("takes the build's west4.json, the environment winning, the local staff app last", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "west4-config-"));
    try {
      writeFileSync(
        path.join(dir, "west4.json"),
        JSON.stringify({ staffUrl: "https://staff.example", apiUrl: "https://api.example" }),
      );
      expect(desktopUrls({}, dir)).toEqual({
        STAFF_URL: "https://staff.example",
        API_URL: "https://api.example",
      });
      expect(desktopUrls({ STAFF_URL: "http://localhost:5173" }, dir).STAFF_URL).toBe(
        "http://localhost:5173",
      );
      expect(desktopUrls({}, path.join(dir, "missing"))).toEqual({
        STAFF_URL: "http://localhost:5173",
        API_URL: undefined,
      });
      expect(desktopUrls({}, null).STAFF_URL).toBe("http://localhost:5173");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
