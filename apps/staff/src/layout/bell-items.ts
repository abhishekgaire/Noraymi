import type { MessageKey } from "@west4/shared";

/**
 * One bell for everything waiting (P-11; U-18; spec 10 · The bell). A short list of what has no
 * home on the screen in front of you: approvals routed to you, tickets that didn't print, guest
 * texts not yet read, and the rooms (a room past its time, a room calling, a free room for the
 * waitlist, a guest running late) and bar orders only when you're not on the screen that already
 * shows them. Each line opens its place (a room's line opens that room's panel on the board) and
 * carries the real action where there is one (On it on a call, Accept on a bar order). The keys
 * this person marked read come from the API (`/bell/reads`), so the count is per person on every
 * screen they sign in to.
 *
 * What's kept for offline holds no guest's name or words: only the kind, the room's name and the
 * key, so a shared computer's storage never carries guest data.
 */
export type BellKind = "approval" | "room" | "order" | "text" | "print";

/** The real action a line carries, through the screen's own route (U-18). */
export type BellAction =
  | { readonly kind: "onIt"; readonly callId: string }
  | { readonly kind: "accept"; readonly orderId: string };

export interface BellItem {
  readonly key: string;
  readonly kind: BellKind;
  readonly labelKey: MessageKey;
  readonly params: Readonly<Record<string, string | number>>;
  /** The screen it opens: a room's line opens that room's panel (`/tonight?room=<id>`). */
  readonly path: string;
  /** The screens that already show it: the bell leaves it out there (U-18). */
  readonly homes?: readonly string[];
  readonly action?: BellAction;
}

export interface BellSources {
  readonly approvals?: readonly {
    readonly id: string;
    readonly kind: string;
    readonly requested_by_name: string;
  }[];
  /** The room lines from `GET /bell/alerts` (U-18). */
  readonly alerts?: readonly BellRoomLine[];
  readonly orders?: readonly {
    readonly id: string;
    readonly status: string;
    readonly room_name: string | null;
  }[];
  readonly conversations?: readonly {
    readonly id: string;
    readonly unread: number;
    readonly last_inbound_at?: string | null;
  }[];
  readonly failed?: readonly {
    readonly id: string;
    readonly room_name?: string | null;
    readonly kitchen?: boolean;
  }[];
}

/** One of the bell's room lines (GET /bell/alerts); the bell reads only the fields it names. */
export type BellRoomLine = {
  readonly kind: string;
  readonly room_id: string;
  readonly room_name: string;
} & Readonly<Record<string, unknown>>;

const CALLS = new Set(["mic", "tv", "check", "other"]);

/** The board's link that opens one room's panel (U-18). */
export const roomPath = (roomId: string) => `/tonight?room=${encodeURIComponent(roomId)}`;

/**
 * Everything waiting, in the bell's order: approvals first (someone is standing there), then the
 * rooms in the server's order (time's up, calls, the waitlist, late guests), bar orders, guest
 * texts and tickets that didn't print.
 */
export function bellItems(s: BellSources): BellItem[] {
  const items: BellItem[] = [];
  for (const a of s.approvals ?? [])
    items.push({
      key: `approval:${a.id}`,
      kind: "approval",
      labelKey: "bell.item.approval",
      params: { kind: a.kind, name: a.requested_by_name },
      path: "/approvals",
      homes: ["/approvals"],
    });
  for (const a of s.alerts ?? []) {
    const room = String(a.room_name ?? "");
    const path = roomPath(String(a.room_id));
    switch (a.kind) {
      case "time_up": {
        const words = (a["words"] ?? {}) as { kind?: string; minutes_past?: number };
        const needed = words.kind === "needed_now";
        items.push({
          // A room that goes from Staying to Needed now (someone booked next) counts again.
          key: `room:time_up:${String(a["session_id"])}:${needed ? "needed_now" : "staying"}`,
          kind: "room",
          labelKey: needed ? "bell.item.neededNow" : "bell.item.staying",
          params: { room, min: Number(words.minutes_past ?? 0) },
          path,
          homes: ["/tonight"],
        });
        break;
      }
      case "call": {
        const call = String(a["call"]);
        items.push({
          key: `room:call:${String(a["call_id"])}`,
          kind: "room",
          labelKey: `bell.item.call.${CALLS.has(call) ? call : "other"}` as MessageKey,
          params: { room },
          path,
          homes: ["/tonight", "/calls"],
          action: { kind: "onIt", callId: String(a["call_id"]) },
        });
        break;
      }
      case "offer":
        items.push({
          key: `room:offer:${String(a["entry_id"])}:${room}`,
          kind: "room",
          labelKey: "bell.item.offer",
          params: { room },
          path,
          homes: ["/tonight"],
        });
        break;
      case "late":
        items.push({
          key: `room:late:${String(a["booking_id"])}`,
          kind: "room",
          labelKey: "bell.item.late",
          params: { room },
          path,
          homes: ["/tonight"],
        });
        break;
    }
  }
  for (const o of s.orders ?? [])
    items.push({
      key: `order:${o.id}`,
      kind: "order",
      labelKey: o.room_name
        ? o.status === "held"
          ? "bell.item.orderHeld"
          : "bell.item.order"
        : o.status === "held"
          ? "bell.item.orderHeld.noRoom"
          : "bell.item.order.noRoom",
      params: { room: o.room_name ?? "" },
      path: "/bar-orders",
      homes: ["/bar-orders"],
      action: { kind: "accept", orderId: o.id },
    });
  for (const c of s.conversations ?? [])
    if (c.unread > 0)
      items.push({
        key: `text:${c.id}:${c.last_inbound_at ?? ""}`,
        kind: "text",
        labelKey: "bell.item.text",
        params: { count: c.unread },
        path: "/messages",
        homes: ["/messages"],
      });
  for (const j of s.failed ?? [])
    items.push({
      key: `print:${j.id}`,
      kind: "print",
      labelKey: j.kitchen
        ? j.room_name
          ? "kitchen.ticket.failedRoom"
          : "kitchen.ticket.failed"
        : j.room_name
          ? "alert.ticket"
          : "alert.ticket.noRoom",
      params: { room: j.room_name ?? "" },
      path: "/bar",
    });
  return items;
}

/** What the bell shows on this screen: the lines whose home it isn't (U-18). */
export function bellShown(items: readonly BellItem[], pathname: string): BellItem[] {
  return items.filter((i) => !(i.homes ?? []).includes(pathname));
}

/** The bell's number: the things in its list this person hasn't marked read. */
export function unreadCount(items: readonly BellItem[], read: ReadonlySet<string>): number {
  return items.filter((i) => !read.has(i.key)).length;
}

/** What the bell keeps per person for offline: the list as of its last answer and the reads. */
export interface BellCache {
  readonly items: readonly BellItem[];
  readonly read: readonly string[];
  /** Marked read while the API didn't answer; sent when it does. */
  readonly pending: readonly string[];
  /** When the list was last live (an ISO instant). */
  readonly at: string;
}

export const bellCacheKey = (venueId: string, userId: string) => `west4.bell.${venueId}.${userId}`;

export function readBellCache(venueId: string, userId: string): BellCache | null {
  try {
    const raw = localStorage.getItem(bellCacheKey(venueId, userId));
    if (!raw) return null;
    const c = JSON.parse(raw) as BellCache;
    return Array.isArray(c.items) && Array.isArray(c.read)
      ? { ...c, pending: c.pending ?? [] }
      : null;
  } catch {
    return null;
  }
}

export function writeBellCache(venueId: string, userId: string, cache: BellCache): void {
  try {
    localStorage.setItem(bellCacheKey(venueId, userId), JSON.stringify(cache));
  } catch {
    // Private windows and full storage: the bell still works live.
  }
}
