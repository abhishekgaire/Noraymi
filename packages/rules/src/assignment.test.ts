import { describe, expect, it } from "vitest";
import { Temporal } from "@west4/shared";
import {
  assignmentOrder,
  canExtend,
  chooseRoom,
  freeRoomsFor,
  freeUntil,
  type BlockSpan,
} from "./assignment.js";

const at = (hhmm: string, day = "2026-09-25") => Temporal.Instant.from(`${day}T${hhmm}:00-04:00`);
const room = (name: string, min: number, max: number) => ({
  id: name,
  name,
  capacityMin: min,
  capacityMax: max,
  cleaningMin: 0,
  available: true,
});
const small = [1, 2, 3].map((n) => room(`Room ${n}`, 3, 6));
const medium = [6, 8].map((n) => room(`Room ${n}`, 6, 12));
const large = [room("Room 11", 12, 20)];
const all = [...large, ...medium, ...small];
const close = at("04:00", "2026-09-26");

describe("assignment", () => {
  it("orders by capacity: small, medium, large", () => {
    expect(assignmentOrder(all).map((r) => r.name)).toEqual([
      "Room 1",
      "Room 2",
      "Room 3",
      "Room 6",
      "Room 8",
      "Room 11",
    ]);
  });

  it("a party of 7 gets a medium room when one is free, and Room 11 only when none is", () => {
    expect(chooseRoom(all, [], 7, at("23:00"), at("01:00", "2026-09-26"), close)).toMatchObject({
      room: { name: "Room 6" },
    });
    const mediumBusy: BlockSpan[] = medium.map((r) => ({
      roomId: r.id,
      from: at("22:00"),
      to: at("02:00", "2026-09-26"),
    }));
    expect(
      chooseRoom(all, mediumBusy, 7, at("23:00"), at("01:00", "2026-09-26"), close),
    ).toMatchObject({ room: { name: "Room 11" } });
  });

  it("refuses a booking that would end after the close, and says when nothing fits", () => {
    expect(
      chooseRoom(all, [], 4, at("03:00", "2026-09-26"), at("04:30", "2026-09-26"), close),
    ).toEqual({ refused: "past_close" });
    expect(chooseRoom(all, [], 25, at("23:00"), at("00:00", "2026-09-26"), close)).toEqual({
      refused: "no_room",
    });
  });

  it("a switched-off room and cleaning minutes count; open-ended blocks block for good", () => {
    const withCleaning = [{ ...room("Room 1", 3, 6), cleaningMin: 15 }];
    const blocks: BlockSpan[] = [
      { roomId: "Room 1", from: at("23:10"), to: at("00:00", "2026-09-26") },
    ];
    expect(freeRoomsFor(withCleaning, blocks, 4, at("22:00"), at("23:00"))).toHaveLength(0);
    expect(freeRoomsFor(withCleaning, blocks, 4, at("22:00"), at("22:55"))).toHaveLength(1);
    expect(
      freeRoomsFor(
        [{ ...room("Room 1", 3, 6), available: false }],
        [],
        4,
        at("22:00"),
        at("23:00"),
      ),
    ).toHaveLength(0);
    expect(
      freeRoomsFor(
        small,
        [{ roomId: "Room 1", from: at("20:00"), to: null }],
        4,
        at("23:00"),
        at("23:30"),
      ).map((r) => r.name),
    ).toEqual(["Room 2", "Room 3"]);
  });

  it("free until: the next block, or all night", () => {
    const blocks: BlockSpan[] = [
      { roomId: "Room 8", from: at("23:00"), to: at("01:00", "2026-09-26") },
      { roomId: "Room 2", from: at("22:30"), to: at("23:30") },
    ];
    expect(freeUntil("Room 8", blocks, at("22:41"))).toEqual({ freeNow: true, until: at("23:00") });
    expect(freeUntil("Room 11", blocks, at("22:41"))).toEqual({ freeNow: true, until: null });
    expect(freeUntil("Room 2", blocks, at("22:41"))).toEqual({
      freeNow: false,
      until: at("23:30"),
    });
  });

  it("a session extends 15 minutes at a time while nothing is booked next", () => {
    expect(canExtend(at("22:30"), at("23:00"), 10, 0, close)).toEqual({
      ok: true,
      to: at("22:45"),
    });
    expect(canExtend(at("22:45"), at("23:00"), 10, 0, close)).toEqual({
      ok: false,
      why: "booked_next",
    });
    expect(canExtend(at("22:45"), null, 10, 0, close)).toEqual({ ok: true, to: at("23:00") });
    expect(canExtend(at("03:50", "2026-09-26"), null, 10, 0, close)).toEqual({
      ok: false,
      why: "past_close",
    });
  });
});
