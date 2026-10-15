import { beforeEach, describe, expect, it } from "vitest";
import { catalogs } from "@west4/shared";
import { bellItems, readBellCache, unreadCount, writeBellCache } from "./bell-items.js";

const sources = {
  approvals: [{ id: "a1", kind: "comp", requested_by_name: "Andy" }],
  alerts: [
    { kind: "call", call_id: "c1", room_name: "Room 9", call: "check" },
    { kind: "near_end", session_id: "s2", room_name: "Room 6" },
    { kind: "needed_now", session_id: "s3", room_name: "Room 13" },
    {
      kind: "wipe",
      rooms: [
        { room_id: "r6", name: "Room 6" },
        { room_id: "r13", name: "Room 13" },
      ],
      waiting: [],
    },
    { kind: "order", order_id: "o1", room_name: "Room 9" },
    { kind: "ticket", job_id: "j1", room_name: "Room 9" },
    { kind: "age", at: "x" },
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
      "room:call:c1",
      "room:needed_now:s3",
      "room:wipe:r6",
      "room:wipe:r13",
      "order:o1",
      "order:o2",
      "text:t1:2026-09-26T02:30:00Z",
      "print:j1",
      "print:j2",
    ]);
    expect(items.map((i) => i.path)).toEqual([
      "/approvals",
      "/calls",
      "/tonight",
      "/tonight",
      "/tonight",
      "/bar-orders",
      "/bar-orders",
      "/messages",
      "/bar",
      "/bar",
    ]);
    expect(items[1]!.labelKey).toBe("bell.item.call.check");
    expect(items[6]!.labelKey).toBe("bell.item.orderHeld.noRoom");
    expect(items[9]!.labelKey).toBe("kitchen.ticket.failed");
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
