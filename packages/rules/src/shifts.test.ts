import { describe, expect, it } from "vitest";
import { Temporal } from "@west4/shared";
import { businessDate } from "./time.js";
import { dutiesFor, shiftMinutes, splitShifts, type Punch } from "./shifts.js";

const NY = "America/New_York";
const at = (wall: string) => Temporal.PlainDateTime.from(wall).toZonedDateTime(NY).toInstant();
const p = (kind: Punch["kind"], wall: string): Punch => ({ kind, at: at(wall) });

describe("shiftMinutes (M7-01)", () => {
  it("counts the demo night: Maya on since 4:00 PM is 6h 41m at 10:41 PM", () => {
    const m = shiftMinutes([p("clock_in", "2026-09-25T16:00")], at("2026-09-25T22:41"));
    expect(m.workedMinutes).toBe(6 * 60 + 41);
    expect(m.endedAt).toBeNull();
    expect(m.breakMinutes).toBe(0);
  });

  it("takes breaks off the worked minutes, an open break counted up to now", () => {
    const punches = [
      p("clock_in", "2026-09-25T16:00"),
      p("break_start", "2026-09-25T19:00"),
      p("break_end", "2026-09-25T19:20"),
      p("break_start", "2026-09-25T22:35"),
    ];
    const m = shiftMinutes(punches, at("2026-09-25T22:41"));
    expect(m.breakMinutes).toBe(26);
    expect(m.closedBreakMinutes).toBe(20);
    expect(m.workedMinutes).toBe(401 - 26);
    expect(m.breakStartedAt?.equals(at("2026-09-25T22:35"))).toBe(true);
  });

  it("ends an open break with the clock-out", () => {
    const m = shiftMinutes([
      p("clock_in", "2026-09-25T16:00"),
      p("break_start", "2026-09-26T01:00"),
      p("clock_out", "2026-09-26T01:30"),
    ]);
    expect(m.closedBreakMinutes).toBe(30);
    expect(m.workedMinutes).toBe(9 * 60);
    expect(m.breakStartedAt).toBeNull();
  });

  it("counts the fall-back night by elapsed time: 4:00 PM Sat Oct 31 to 4:30 AM Sun Nov 1 is 810 minutes", () => {
    const punches = [p("clock_in", "2026-10-31T16:00"), p("clock_out", "2026-11-01T04:30")];
    expect(shiftMinutes(punches).workedMinutes).toBe(810);
    expect(businessDate(punches[0]!.at, NY, "06:00").businessDate.toString()).toBe("2026-10-31");
  });

  it("counts the spring-forward night: 4:00 PM Sat Mar 13 to 4:30 AM Sun Mar 14, 2027 is 690 minutes", () => {
    const punches = [p("clock_in", "2027-03-13T16:00"), p("clock_out", "2027-03-14T04:30")];
    expect(shiftMinutes(punches).workedMinutes).toBe(690);
    expect(businessDate(punches[0]!.at, NY, "06:00").businessDate.toString()).toBe("2027-03-13");
  });

  it("belongs to its clock-in's business date across the 6:00 AM cutover", () => {
    expect(businessDate(at("2026-09-26T05:59"), NY, "06:00").businessDate.toString()).toBe(
      "2026-09-25",
    );
    expect(businessDate(at("2026-09-26T06:00"), NY, "06:00").businessDate.toString()).toBe(
      "2026-09-26",
    );
    // A shift that runs past the cutover keeps counting: 11:00 PM to 7:00 AM is 8 hours.
    const m = shiftMinutes([p("clock_in", "2026-09-25T23:00"), p("clock_out", "2026-09-26T07:00")]);
    expect(m.workedMinutes).toBe(480);
  });

  it("refuses punches that don't start with a clock-in", () => {
    expect(() => shiftMinutes([p("break_start", "2026-09-25T19:00")])).toThrow();
  });
});

describe("splitShifts", () => {
  it("splits a person's punches into shifts at each clock-in", () => {
    const shifts = splitShifts([
      p("clock_out", "2026-09-25T20:00"),
      p("clock_in", "2026-09-25T16:00"),
      p("clock_in", "2026-09-25T21:00"),
      p("break_start", "2026-09-25T22:00"),
    ]);
    expect(shifts.map((s) => s.map((x) => x.kind))).toEqual([
      ["clock_in", "clock_out"],
      ["clock_in", "break_start"],
    ]);
  });
});

describe("dutiesFor (cautious default: Manager for owners and managers only)", () => {
  it("offers Manager only to owners and managers", () => {
    expect(dutiesFor("owner")).toContain("manager");
    expect(dutiesFor("manager")).toContain("manager");
    for (const role of ["bartender", "front_desk", "staff"])
      expect(dutiesFor(role)).toEqual(["bar", "front_desk", "runner"]);
  });
});
