import { beforeEach, describe, expect, it, vi } from "vitest";
import { Temporal } from "@west4/shared";
import { codeNow, keptCodes, type DeviceCodes } from "./offline-codes.js";

/** A manager's phone (M8-04): the kept codes, read at Sat 2:41 AM with no connection. */
const bar: DeviceCodes = {
  device_id: "bar",
  name: "Bar computer",
  kind: "bar_computer",
  codes: [
    { starts_at: "2026-09-26T06:40:00Z", ends_at: "2026-09-26T06:45:00Z", code: "123456" },
    { starts_at: "2026-09-26T06:45:00Z", ends_at: "2026-09-26T06:50:00Z", code: "654321" },
  ],
};

describe("offline codes kept on a manager's phone", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
  });

  it("show the code for the step now, and the next one from its start", () => {
    expect(codeNow(bar, Temporal.Instant.from("2026-09-26T06:41:00Z"))).toEqual({
      code: "123456",
      ends_at: "2026-09-26T06:45:00Z",
    });
    expect(codeNow(bar, Temporal.Instant.from("2026-09-26T06:45:00Z"))?.code).toBe("654321");
  });

  it("show nothing once the kept codes have run out", () => {
    expect(codeNow(bar, Temporal.Instant.from("2026-09-26T06:50:00Z"))).toBeNull();
  });

  it("read back what was kept for the venue, and nothing for another", () => {
    localStorage.setItem(
      "west4.offlineCodes.v1",
      JSON.stringify({ fetched_at: "2026-09-26T02:41:00Z", devices: [bar] }),
    );
    expect(keptCodes("v1")?.devices[0]?.name).toBe("Bar computer");
    expect(keptCodes("v2")).toBeNull();
  });
});
