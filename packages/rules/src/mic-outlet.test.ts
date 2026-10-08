import { describe, expect, it } from "vitest";
import {
  MIC_COMMAND_TTL_MS,
  acceptMicCommand,
  micCommandSigningString,
  micDesired,
  outletPower,
  type MicCommand,
} from "./mic-outlet.js";

const OUTLET = "outlet-1";
const off = (issuedAtMs: number, over: Partial<MicCommand> = {}): MicCommand => ({
  deviceId: OUTLET,
  state: "off",
  issuedAtMs,
  ttlMs: MIC_COMMAND_TTL_MS,
  ...over,
});
const take = (
  memory: Parameters<typeof acceptMicCommand>[0],
  c: MicCommand,
  nowMs: number,
  ok = true,
) => acceptMicCommand(memory, c, { deviceId: OUTLET, signatureValid: ok, nowMs });

describe("what the server tells the mic outlet (M8-23)", () => {
  it("on while the trial room has an open session, off after close-out", () => {
    expect(micDesired({ trialRoomId: "r9", outletRoomId: "r9", sessionOpen: true })).toEqual({
      state: "on",
      reason: "session_open",
    });
    expect(micDesired({ trialRoomId: "r9", outletRoomId: "r9", sessionOpen: false })).toEqual({
      state: "off",
      reason: "no_session",
    });
  });

  it("with the flag off, or for another room, the mics stay on", () => {
    expect(micDesired({ trialRoomId: null, outletRoomId: "r9", sessionOpen: false }).state).toBe(
      "on",
    );
    expect(micDesired({ trialRoomId: "r9", outletRoomId: "r3", sessionOpen: false }).state).toBe(
      "on",
    );
  });
});

describe("the outlet's firmware rule", () => {
  it("powers on with no command at all", () => {
    expect(outletPower(null, 0)).toBe("on");
  });

  it("powers off on a fresh signed off command, and back on when contact is lost", () => {
    const m = take(null, off(1_000), 5_000).memory;
    expect(outletPower(m, 5_000)).toBe("off");
    expect(outletPower(m, 5_000 + MIC_COMMAND_TTL_MS - 1)).toBe("off");
    // Our server can't be reached: no new command, so the old one runs out.
    expect(outletPower(m, 5_000 + MIC_COMMAND_TTL_MS)).toBe("on");
  });

  it("ignores a stale (replayed) command, an unsigned one, another outlet's and an over-long one", () => {
    const m = take(null, { ...off(2_000), state: "on" }, 2_000).memory;
    expect(take(m, off(2_000), 3_000).rejected).toBe("replayed");
    expect(take(m, off(1_000), 3_000).rejected).toBe("replayed");
    expect(take(m, off(3_000), 3_000, false).rejected).toBe("bad_signature");
    expect(take(m, off(3_000, { deviceId: "outlet-2" }), 3_000).rejected).toBe("other_outlet");
    expect(take(m, off(3_000, { ttlMs: 3_600_000 }), 3_000).rejected).toBe("ttl_too_long");
    expect(outletPower(take(m, off(3_000), 3_000, false).memory, 3_000)).toBe("on");
  });

  it("a clock jumping backwards doesn't hold the room off", () => {
    const m = take(null, off(1_000), 10_000).memory;
    expect(outletPower(m, 9_000)).toBe("on");
  });

  it("signs every field", () => {
    expect(micCommandSigningString(off(7))).toBe(`west4-mic-outlet-v1\n${OUTLET}\noff\n7\n60000`);
  });
});
