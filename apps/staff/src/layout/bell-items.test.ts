import { beforeEach, describe, expect, it } from "vitest";
import { catalogs } from "@west4/shared";
import { bellItems, bellShown, readBellCache, unreadCount, writeBellCache } from "./bell-items.js";

const sources = {
  approvals: [{ id: "a1", kind: "comp", requested_by_name: "Andy" }],
  // GET /bell/alerts (U-18): the room lines only, each naming its room.
  alerts: [
    {
      kind: "time_up",
      room_id: "r13",
      room_name: "Room 13",
      session_id: "s3",
      words: { kind: "needed_now", minutes_past: 11 },
    },
    {
      kind: "time_up",
      room_id: "r10",
      room_name: "Room 10",
      session_id: "s10",
      words: { kind: "staying", minutes_past: 41 },
    },
    { kind: "call", room_id: "r9", call_id: "c1", room_name: "Room 9", call: "check" },
    { kind: "offer", room_id: "r11", entry_id: "w1", room_name: "Room 11" },
    // A kind the bell doesn't list (an older API's wipe line) is left out.
    { kind: "wipe", room_id: "r6", room_name: "Room 6" },
  ],
  orders: [
    { id: "o1", status: "ringing", room_name: "Room 9" },
    { id: "o2", status: "held", room_name: null },
  ],
  conversations: [
    { id: "t1", unread: 2, last_inbound_at: "2026-09-26T02:30:00Z" },
    { id: "t2", unread: 0, last_inbound_at: "2026-09-26T01:00:00Z" },
  ],
  failed: [
    { id: "j1", room_name: "Room 9" },
    { id: "j2", kitchen: true },
  ],
};

describe("the bell's list (P-11)", () => {
  it("lists what's waiting in the bell's order, each opening its screen", () => {
    const items = bellItems(sources);
    expect(items.map((i) => i.key)).toEqual([
      "approval:a1",
      "room:time_up:s3:needed_now",
      "room:time_up:s10:staying",
      "room:call:c1",
      "room:offer:w1:Room 11",
      "order:o1",
      "order:o2",
      "text:t1:2026-09-26T02:30:00Z",
      "print:j1",
      "print:j2",
    ]);
    // Every room line opens that room's panel on the board (U-18).
    expect(items.map((i) => i.path)).toEqual([
      "/approvals",
      "/tonight?room=r13",
      "/tonight?room=r10",
      "/tonight?room=r9",
      "/tonight?room=r11",
      "/bar-orders",
      "/bar-orders",
      "/messages",
      "/bar",
      "/bar",
    ]);
    expect(items[1]).toMatchObject({
      labelKey: "bell.item.neededNow",
      params: { room: "Room 13", min: 11 },
    });
    expect(items[2]).toMatchObject({
      labelKey: "bell.item.staying",
      params: { room: "Room 10", min: 41 },
    });
    expect(items[3]!.labelKey).toBe("bell.item.call.check");
    expect(items[6]!.labelKey).toBe("bell.item.orderHeld.noRoom");
    expect(items[9]!.labelKey).toBe("kitchen.ticket.failed");
  });

  it("carries the real action where there is one: On it on a call, Accept on a bar order", () => {
    const items = bellItems(sources);
    expect(items.find((i) => i.key === "room:call:c1")?.action).toEqual({
      kind: "onIt",
      callId: "c1",
    });
    expect(items.find((i) => i.key === "order:o1")?.action).toEqual({
      kind: "accept",
      orderId: "o1",
    });
    expect(items.filter((i) => i.action).length).toBe(3);
  });

  it("leaves out what the screen in front of you already shows (U-18)", () => {
    const items = bellItems(sources);
    const on = (path: string) => bellShown(items, path).map((i) => i.key);
    // On the board: no room lines; approvals, orders, texts and prints stay.
    expect(on("/tonight")).toEqual([
      "approval:a1",
      "order:o1",
      "order:o2",
      "text:t1:2026-09-26T02:30:00Z",
      "print:j1",
      "print:j2",
    ]);
    // On Calls the call is there already; the room's time's up is still the bell's.
    expect(on("/calls")).not.toContain("room:call:c1");
    expect(on("/calls")).toContain("room:time_up:s3:needed_now");
    expect(on("/bar-orders").some((k) => k.startsWith("order:"))).toBe(false);
    expect(on("/bar")).toHaveLength(items.length);
  });

  it("has every word in English and Spanish", () => {
    for (const item of bellItems(sources)) {
      expect(catalogs.en[item.labelKey]).toBeTruthy();
      expect(catalogs.es[item.labelKey]).toBeTruthy();
    }
  });

  it("counts only what this person hasn't read, so the count matches the list and clears on read", () => {
    const items = bellItems(sources);
    expect(unreadCount(items, new Set())).toBe(items.length);
    expect(unreadCount(items, new Set(["approval:a1", "order:o2"]))).toBe(items.length - 2);
    expect(unreadCount(items, new Set(items.map((i) => i.key)))).toBe(0);
  });

  it("rings again for a new text in a thread already read", () => {
    const before = bellItems({ conversations: [{ id: "t1", unread: 1, last_inbound_at: "a" }] });
    const after = bellItems({ conversations: [{ id: "t1", unread: 2, last_inbound_at: "b" }] });
    expect(unreadCount(after, new Set(before.map((i) => i.key)))).toBe(1);
  });

  it("is empty when nothing is waiting", () => {
    expect(bellItems({})).toEqual([]);
  });
});

describe("the bell's offline copy", () => {
  // The unit suite runs in Node: a Map stands in for the browser's storage.
  beforeEach(() => {
    const store = new Map<string, string>();
    globalThis.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    } as Storage;
  });

  it("is kept per venue and per person, with no guest's name or words", () => {
    const items = bellItems(sources);
    writeBellCache("v1", "u1", {
      items,
      read: ["approval:a1"],
      pending: [],
      at: "2026-09-26T02:41:00Z",
    });
    expect(readBellCache("v1", "u1")?.items).toHaveLength(items.length);
    expect(readBellCache("v1", "u2")).toBeNull();
    expect(readBellCache("v2", "u1")).toBeNull();
    const raw = JSON.stringify(readBellCache("v1", "u1"));
    expect(raw).not.toContain("last_body");
  });

  it("reads as nothing when storage holds something else", () => {
    localStorage.setItem("west4.bell.v1.u1", "{not json");
    expect(readBellCache("v1", "u1")).toBeNull();
  });
});
