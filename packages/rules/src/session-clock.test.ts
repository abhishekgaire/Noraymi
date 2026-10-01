import { describe, expect, it } from "vitest";
import { Temporal, cents } from "@west4/shared";
import { sessionClock } from "./session-clock.js";

const at = (hhmm: string, day = "2026-09-25") => Temporal.Instant.from(`${day}T${hhmm}:00-04:00`);
const close = at("04:00", "2026-09-26");
const base = { close, stayOnWhenFree: true, noticeMin: 10, firstHourMinimum: true } as const;
const seg = (start: string, hourly: number) => [
  { startedAt: at(start), endedAt: null, hourlyCents: cents(hourly), paused: false },
];

describe("the room clock", () => {
  it("Room 9 at 10:41 PM: 161 minutes, $322.00, 19 minutes left", () => {
    const c = sessionClock({
      ...base,
      segments: seg("20:00", 12000),
      now: at("22:41"),
      bookedEnd: at("23:00"),
      nextNeedsRoomAt: null,
    });
    expect(c).toMatchObject({
      minutes: 161,
      roomTimeCents: 32200,
      tile: { kind: "in_room", minutesLeft: 19 },
      wrapUp: false,
    });
  });

  it("the VIP room: 71 minutes, $295.83; Room 5: 41 minutes, $40.00 with the first-hour minimum", () => {
    expect(
      sessionClock({
        ...base,
        segments: seg("21:30", 25000),
        now: at("22:41"),
        bookedEnd: at("00:30", "2026-09-26"),
        nextNeedsRoomAt: null,
      }),
    ).toMatchObject({ minutes: 71, roomTimeCents: 29583 });
    expect(
      sessionClock({
        ...base,
        segments: seg("22:00", 4000),
        now: at("22:41"),
        bookedEnd: null,
        nextNeedsRoomAt: null,
      }),
    ).toMatchObject({ minutes: 41, roomTimeCents: 4000, tile: { kind: "walk_in" } });
  });

  it("Room 10: staying 41 minutes past its 10:00 PM end with nobody next, billing on, offered to stay on", () => {
    const c = sessionClock({
      ...base,
      segments: seg("19:00", 9000),
      now: at("22:41"),
      bookedEnd: at("22:00"),
      nextNeedsRoomAt: null,
    });
    expect(c).toMatchObject({
      minutes: 221,
      roomTimeCents: 33150,
      tile: { kind: "staying", minutesPast: 41 },
      stayOnOffer: true,
      wrapUp: false,
    });
  });

  it("Room 7: needed now when someone is booked next, in wrap-up, and no stay-on offer", () => {
    const c = sessionClock({
      ...base,
      segments: seg("20:30", 7000),
      now: at("22:41"),
      bookedEnd: at("22:30"),
      nextNeedsRoomAt: at("23:00"),
    });
    expect(c).toMatchObject({
      tile: { kind: "needed_now", minutesPast: 11 },
      stayOnOffer: false,
      wrapUp: true,
    });
  });

  it("wrap-up starts 10 minutes before a booked end when someone is next", () => {
    const opts = {
      ...base,
      segments: seg("20:45", 5000),
      bookedEnd: at("22:45"),
      nextNeedsRoomAt: at("23:00"),
    };
    expect(sessionClock({ ...opts, now: at("22:34") }).wrapUp).toBe(false);
    expect(sessionClock({ ...opts, now: at("22:35") }).wrapUp).toBe(true);
  });

  it("at 3:30 AM no offer to stay on; at the 4:00 AM close every room is in wrap-up", () => {
    const opts = { ...base, segments: seg("22:00", 4000), bookedEnd: null, nextNeedsRoomAt: null };
    expect(sessionClock({ ...opts, now: at("03:29", "2026-09-26") }).stayOnOffer).toBe(true);
    expect(sessionClock({ ...opts, now: at("03:30", "2026-09-26") })).toMatchObject({
      stayOnOffer: false,
      wrapUp: false,
    });
    expect(sessionClock({ ...opts, now: at("04:00", "2026-09-26") })).toMatchObject({
      stayOnOffer: false,
      wrapUp: true,
    });
  });

  it("a mistaken end and a resume bill straight through when the segment reopens", () => {
    const c = sessionClock({
      ...base,
      segments: seg("22:00", 4000),
      now: at("23:10"),
      bookedEnd: null,
      nextNeedsRoomAt: null,
    });
    expect(c).toMatchObject({ minutes: 70, roomTimeCents: 4667 });
  });
});
