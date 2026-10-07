import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Temporal } from "@west4/shared";
import { alcoholStateAt } from "./alcohol-window.js";
import {
  checkOfflineCode,
  offlineCodeAt,
  printedOfflineCodes,
  queueModeEndsAt,
  upcomingOfflineCodes,
  type Hmac,
  type OfflineCodeScope,
} from "./offline-codes.js";

const hmac: Hmac = (secret, message) =>
  createHmac("sha256", Buffer.from(secret, "hex")).update(message).digest();
const secret = "11".repeat(32);
const bar: OfflineCodeScope = {
  deviceId: "bar-computer",
  timeZone: "America/New_York",
  dayCutover: "06:00",
};
const desk: OfflineCodeScope = { ...bar, deviceId: "front-desk" };
// Sat 2:41 AM on Fri Sep 25's business date.
const at = Temporal.Instant.from("2026-09-26T06:41:00Z");
const plus = (m: number) => at.add({ minutes: m });

describe("time-based offline codes", () => {
  it("are 6 digits, the same through one 5-minute step, and change with the next", () => {
    const code = offlineCodeAt(hmac, secret, bar, at);
    expect(code).toMatch(/^\d{6}$/);
    expect(offlineCodeAt(hmac, secret, bar, Temporal.Instant.from("2026-09-26T06:44:59Z"))).toBe(
      code,
    );
    expect(
      offlineCodeAt(hmac, secret, bar, Temporal.Instant.from("2026-09-26T06:45:00Z")),
    ).not.toBe(code);
  });

  it("are accepted one step either side of the device's clock, and not two", () => {
    const code = offlineCodeAt(hmac, secret, bar, at);
    expect(checkOfflineCode(hmac, secret, bar, at, code)).toEqual({ ok: true, kind: "time" });
    expect(checkOfflineCode(hmac, secret, bar, plus(5), code).ok).toBe(true);
    expect(checkOfflineCode(hmac, secret, bar, plus(-5), code).ok).toBe(true);
    expect(checkOfflineCode(hmac, secret, bar, plus(10), code)).toEqual({
      ok: false,
      reason: "wrong",
    });
    expect(checkOfflineCode(hmac, secret, bar, plus(-10), code).ok).toBe(false);
  });

  it("are bound to the device: the front desk's code doesn't open the bar computer", () => {
    const deskCode = offlineCodeAt(hmac, secret, desk, at);
    expect(deskCode).not.toBe(offlineCodeAt(hmac, secret, bar, at));
    expect(checkOfflineCode(hmac, secret, bar, at, deskCode).ok).toBe(false);
  });

  it("are bound to the secret, and read with spaces or a dash", () => {
    const code = offlineCodeAt(hmac, secret, bar, at);
    expect(checkOfflineCode(hmac, "22".repeat(32), bar, at, code).ok).toBe(false);
    expect(checkOfflineCode(hmac, secret, bar, at, `${code.slice(0, 3)} ${code.slice(3)}`).ok).toBe(
      true,
    );
    expect(checkOfflineCode(hmac, secret, bar, at, "12a456")).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(checkOfflineCode(hmac, secret, bar, at, "1234").ok).toBe(false);
  });

  it("are bound to the business date: the same instant under another cutover is another code", () => {
    // 6:41 AM UTC is 2:41 AM in New York (Fri's night) but 6:41 AM in London (Sat's day).
    const london = { ...bar, timeZone: "Europe/London" };
    expect(offlineCodeAt(hmac, secret, london, at)).not.toBe(offlineCodeAt(hmac, secret, bar, at));
  });

  it("a manager's phone keeps 12 hours of them, one per step, matching the device's", () => {
    const codes = upcomingOfflineCodes(hmac, secret, bar, at);
    expect(codes).toHaveLength(144);
    expect(codes[0]).toEqual({
      starts_at: "2026-09-26T06:40:00Z",
      ends_at: "2026-09-26T06:45:00Z",
      code: offlineCodeAt(hmac, secret, bar, at),
    });
    const later = codes[30]!;
    expect(
      checkOfflineCode(hmac, secret, bar, Temporal.Instant.from(later.starts_at), later.code).ok,
    ).toBe(true);
  });
});

describe("printed offline codes", () => {
  const tonight = printedOfflineCodes(hmac, secret, "bar-computer", "2026-09-25");

  it("are ten 8-digit codes for one device and one business date", () => {
    expect(tonight).toHaveLength(10);
    for (const c of tonight) expect(c).toMatch(/^\d{8}$/);
    expect(new Set(tonight).size).toBe(10);
  });

  it("open the device on that business date, each once", () => {
    expect(checkOfflineCode(hmac, secret, bar, at, tonight[3]!)).toEqual({
      ok: true,
      kind: "printed",
      date: "2026-09-25",
      index: 3,
    });
    expect(checkOfflineCode(hmac, secret, bar, at, tonight[3]!, [3])).toEqual({
      ok: false,
      reason: "used",
    });
  });

  it("don't open another device, or the same device on another business date", () => {
    const desks = printedOfflineCodes(hmac, secret, "front-desk", "2026-09-25");
    expect(checkOfflineCode(hmac, secret, bar, at, desks[0]!).ok).toBe(false);
    const saturday = printedOfflineCodes(hmac, secret, "bar-computer", "2026-09-26");
    expect(checkOfflineCode(hmac, secret, bar, at, saturday[0]!).ok).toBe(false);
    // 6:00 AM Saturday: Friday's card stops working.
    const next = Temporal.Instant.from("2026-09-26T10:00:00Z");
    expect(checkOfflineCode(hmac, secret, bar, next, tonight[0]!).ok).toBe(false);
    expect(checkOfflineCode(hmac, secret, bar, next, saturday[0]!).ok).toBe(true);
  });
});

describe("queue mode and the kept alcohol window", () => {
  it("queue mode ends 4 hours after it opens", () => {
    expect(queueModeEndsAt(at).toString()).toBe("2026-09-26T10:41:00Z");
  });

  it("an open window heard at 3:59 AM is closed from 4:00 AM, as online", () => {
    const heard = { state: "open", changes_at: "2026-09-26T08:00:00Z" };
    expect(alcoholStateAt(heard, Temporal.Instant.from("2026-09-26T07:59:59Z"))).toBe("open");
    expect(alcoholStateAt(heard, Temporal.Instant.from("2026-09-26T08:00:00Z"))).toBe("closed");
    expect(alcoholStateAt({ state: "closed" }, at)).toBe("closed");
  });
});
