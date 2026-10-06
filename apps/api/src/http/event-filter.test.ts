import { describe, expect, it } from "vitest";
import { toWire } from "@west4/db";
import { visibleTo, type Subscription } from "./event-filter.js";
import { splitDeviceQuery } from "./device-auth.js";
import type { Principal } from "./principal.js";

const V = "venue-1";
const base = {
  venue_id: V,
  room_id: null as string | null,
  audience: "venue" as const,
  user_id: null as string | null,
};
const ev = (over: Partial<typeof base> & { type: string }) => ({ ...base, ...over });
const manager: Principal = {
  kind: "user",
  userId: "andy",
  session: "passkey",
  memberships: [{ venueId: V, membershipId: "m", role: "manager" }],
};
const bartender: Principal = {
  kind: "user",
  userId: "maya",
  session: "badge",
  memberships: [{ venueId: V, membershipId: "m2", role: "bartender" }],
};
const tablet: Principal = { kind: "device", deviceId: "d9", venueId: V, deviceKind: "room_tablet" };
const bar: Principal = { kind: "device", deviceId: "d1", venueId: V, deviceKind: "bar_computer" };
const display: Principal = {
  kind: "device",
  deviceId: "d7",
  venueId: V,
  deviceKind: "up_next_display",
};
const guest: Principal = { kind: "guest", venueId: V, scope: "room_session", id: "room-9" };
const singer: Principal = { kind: "singer", venueId: V, singerId: "s1" };

describe("visibleTo, per principal", () => {
  it("a room tablet on Room 9's channel never receives an event for another room", () => {
    const sub: Subscription = { principal: tablet, venueId: V, roomId: "room-9" };
    expect(visibleTo(sub, ev({ type: "order.ready", room_id: "room-9" }))).toBe(true);
    expect(visibleTo(sub, ev({ type: "order.ready", room_id: "room-11" }))).toBe(false);
    expect(visibleTo(sub, ev({ type: "settings.changed" }))).toBe(false);
    expect(
      visibleTo(sub, ev({ type: "incident.opened", audience: "managers", room_id: "room-9" })),
    ).toBe(false);
  });

  it("a guest in a room sees only their room's guest-safe events", () => {
    const sub: Subscription = { principal: guest, venueId: V, roomId: "room-9" };
    expect(visibleTo(sub, ev({ type: "check.updated", room_id: "room-9" }))).toBe(true);
    expect(
      visibleTo(sub, ev({ type: "check.updated", room_id: "room-9", audience: "staff" })),
    ).toBe(false);
    expect(visibleTo(sub, ev({ type: "check.updated", room_id: "room-11" }))).toBe(false);
  });

  it("a locked shared device gets only ring state; unlocked it gets staff events but not managers' or a person's", () => {
    const locked: Subscription = { principal: bar, venueId: V, locked: true };
    expect(visibleTo(locked, ev({ type: "order.ringing", room_id: "room-9" }))).toBe(true);
    expect(visibleTo(locked, ev({ type: "check.updated", room_id: "room-9" }))).toBe(false);
    const open: Subscription = { principal: bar, venueId: V };
    expect(visibleTo(open, ev({ type: "check.updated", room_id: "room-9" }))).toBe(true);
    expect(visibleTo(open, ev({ type: "incident.opened", audience: "managers" }))).toBe(false);
    expect(visibleTo(open, ev({ type: "draft.updated", audience: "user", user_id: "maya" }))).toBe(
      false,
    );
  });

  it("managers see managers' events, a bartender doesn't; a person's events reach only them", () => {
    expect(
      visibleTo(
        { principal: manager, venueId: V },
        ev({ type: "incident.opened", audience: "managers" }),
      ),
    ).toBe(true);
    expect(
      visibleTo(
        { principal: bartender, venueId: V },
        ev({ type: "incident.opened", audience: "managers" }),
      ),
    ).toBe(false);
    expect(
      visibleTo(
        { principal: bartender, venueId: V },
        ev({ type: "draft.updated", audience: "user", user_id: "maya" }),
      ),
    ).toBe(true);
    expect(
      visibleTo(
        { principal: manager, venueId: V },
        ev({ type: "draft.updated", audience: "user", user_id: "maya" }),
      ),
    ).toBe(false);
  });

  it("the Up next display and singers get only the queue; another venue's events reach nobody", () => {
    expect(visibleTo({ principal: display, venueId: V }, ev({ type: "song_queue.updated" }))).toBe(
      true,
    );
    expect(visibleTo({ principal: display, venueId: V }, ev({ type: "order.ringing" }))).toBe(
      false,
    );
    expect(visibleTo({ principal: singer, venueId: V }, ev({ type: "song_queue.updated" }))).toBe(
      true,
    );
    expect(
      visibleTo(
        { principal: manager, venueId: V },
        ev({ type: "settings.changed", venue_id: "venue-2" }),
      ),
    ).toBe(false);
    expect(
      visibleTo({ principal: { kind: "anonymous" }, venueId: V }, ev({ type: "settings.changed" })),
    ).toBe(false);
  });
});

describe("the wire event", () => {
  it("carries exactly seq, type, id, entity_version and at, and nothing else", () => {
    const wire = toWire({
      seq: "1042",
      type: "order.ringing",
      entity_id: "o1",
      entity_version: 7,
      at: new Date("2026-09-26T02:41:00Z"),
    });
    expect(Object.keys(wire).sort()).toEqual(["at", "entity_version", "id", "seq", "type"]);
    expect(wire).toEqual({
      seq: 1042,
      type: "order.ringing",
      id: "o1",
      entity_version: 7,
      at: "2026-09-26T02:41:00.000Z",
    });
  });
});

// M6-22: the Up next TV's channel carries the queue display and nothing else, whatever the audience.
const EVERY_TYPE = [
  "approval.decided",
  "approval.requested",
  "booking.updated",
  "check.updated",
  "device.updated",
  "drawer.updated",
  "headcount.updated",
  "membership.changed",
  "menu.changed",
  "message.received",
  "message.updated",
  "order.cancelled",
  "order.ready",
  "order.ringing",
  "payment.updated",
  "refund.updated",
  "room.call",
  "room.guest_joined",
  "room.updated",
  "session.code_changed",
  "session.updated",
  "settings.changed",
  "song_queue.updated",
  "tab.awaiting_tip",
  "tab.updated",
  "waitlist.updated",
];
describe("the Up next TV's channel (M6-22)", () => {
  it("passes only song_queue.updated, for every event type and audience, locked or not, in or out of a room", () => {
    for (const type of EVERY_TYPE)
      for (const audience of [null, "staff", "managers", "user", "display"] as const)
        for (const locked of [false, true])
          for (const room_id of [null, "room-9"]) {
            const seen = visibleTo(
              { principal: display, venueId: V, locked, roomId: "room-9" },
              ev({ type, audience, room_id, user_id: "maya" } as never),
            );
            expect(seen, `${type} ${audience} ${locked} ${room_id}`).toBe(
              type === "song_queue.updated",
            );
          }
  });

  it("another venue's TV hears nothing of this venue", () => {
    expect(
      visibleTo(
        { principal: { ...display, venueId: "other" } as Principal, venueId: V },
        ev({ type: "song_queue.updated" }),
      ),
    ).toBe(false);
  });
});

describe("a signed socket URL (M6-22)", () => {
  it("splits off the four device values and keeps the URL as it was signed", () => {
    const s = splitDeviceQuery(
      "/v1/venues/v1/events?after=12&x-device-id=d&x-device-timestamp=1&x-device-nonce=n&x-device-signature=a%2Bb%3D",
    );
    expect(s.signed).toBe(true);
    expect(s.path).toBe("/v1/venues/v1/events?after=12");
    expect(s.values.get("x-device-signature")).toBe("a+b=");
    const plain = splitDeviceQuery("/v1/venues/v1/events?x-device-id=d&x-device-nonce=n");
    expect(plain.path).toBe("/v1/venues/v1/events");
    expect(splitDeviceQuery("/v1/venues/v1/events?after=3").signed).toBe(false);
  });
});
