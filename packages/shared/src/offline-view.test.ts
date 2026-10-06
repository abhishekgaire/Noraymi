import { describe, expect, it } from "vitest";
import { isOfflineRead, offlinePrefetchPaths } from "./offline-view.js";

const V = "/v1/venues/0b6c0c9e-3d0a-4a43-9a43-1c1c2f5a7f10";

describe("the offline view's reads (M8-03)", () => {
  it("keeps the board, open tabs and their checks, the menu and the bar's orders", () => {
    for (const p of offlinePrefetchPaths("0b6c0c9e-3d0a-4a43-9a43-1c1c2f5a7f10", "2026-09-25"))
      expect(isOfflineRead(p), p).toBe(true);
    expect(isOfflineRead(`${V}/checks/5d1e2c1a-0000-4000-8000-000000000009`)).toBe(true);
    expect(isOfflineRead(`${V}/orders?status=cancelled&business_date=2026-09-25`)).toBe(true);
  });

  it("keeps nothing else: no sign-in, no writes' routes, no other venue-free path", () => {
    for (const p of [
      "/v1/auth/me",
      `${V}/connection`,
      `${V}/reports/z?date=2026-09-25`,
      `${V}/menu/items/abc/out-tonight`,
      `${V}/orders?status=ringing;drop`,
      `${V}/checks/../auth`,
      `${V}/board?x=1`,
      "/v1/venues/../board",
    ])
      expect(isOfflineRead(p), p).toBe(false);
  });

  it("asks for the bar orders screen's list only once the business date is known", () => {
    expect(offlinePrefetchPaths("v", null).some((p) => p.includes("business_date"))).toBe(false);
  });
});
