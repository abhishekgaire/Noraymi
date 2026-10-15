import type { MessageKey } from "@west4/shared";

/**
 * One bell for everything waiting (P-11; spec 10 · The bell). What's waiting comes from the lists
 * the screens already read, each only when this person may see it: approvals routed to them, the
 * board's room alerts that need someone, ringing and asked-to-wait bar orders, guest texts not yet
 * read, and tickets that didn't print. Each thing has a key; the keys this person marked read come
 * from the API (`/bell/reads`), so the count is per person on every screen they sign in to.
 *
 * What's kept for offline holds no guest's name or words: only the kind, the room's name and the
 * key, so a shared computer's storage never carries guest data.
 */
export type BellKind = "approval" | "room" | "order" | "text" | "print";

export interface BellItem {
  readonly key: string;
  readonly kind: BellKind;
  readonly labelKey: MessageKey;
  readonly params: Readonly<Record<string, string | number>>;
  /** The screen it opens. */
  readonly path: string;
}

export interface BellSources {
  readonly approvals?: readonly {
    readonly id: string;
    readonly kind: string;
    readonly requested_by_name: string;
  }[];
  readonly alerts?: readonly BoardAlert[];
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

/** One of the board's alerts (GET /board); the bell reads only the fields it names. */
export type BoardAlert = { readonly kind: string } & Readonly<Record<string, unknown>>;

const CALLS = new Set(["mic", "tv", "check", "other"]);

/**
 * Everything waiting, in the bell's order: approvals first (someone is standing there), then the
 * rooms in the board's own order, bar orders, guest texts and tickets that didn't print. The board's
 * near-end, 21+ and clear-out lines are notices, not things to do, and its order and ticket lines
 * are already here as bar orders and printer errors.
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
    });
  for (const alert of s.alerts ?? []) {
    const a = alert;
    const room = String(a["room_name"] ?? "");
    switch (a.kind) {
      case "call": {
        const call = String(a["call"]);
        items.push({
          key: `room:call:${String(a["call_id"])}`,
          kind: "room",
          labelKey: `bell.item.call.${CALLS.has(call) ? call : "other"}` as MessageKey,
          params: { room },
          path: "/calls",
        });
        break;
      }
      case "needed_now":
        items.push({
          key: `room:needed_now:${String(a["session_id"])}`,
          kind: "room",
          labelKey: "bell.item.neededNow",
          params: { room },
          path: "/tonight",
        });
        break;
      case "offer":
        items.push({
          key: `room:offer:${String(a["entry_id"])}:${room}`,
          kind: "room",
          labelKey: "bell.item.offer",
          params: { room },
          path: "/tonight",
        });
        break;
      case "wipe":
        for (const r of (a["rooms"] as readonly { room_id: string; name: string }[]) ?? [])
          items.push({
            key: `room:wipe:${r.room_id}`,
            kind: "room",
            labelKey: "bell.item.wipe",
            params: { room: r.name },
            path: "/tonight",
          });
        break;
      case "code":
        items.push({
          key: `room:code:${String(a["session_id"])}`,
          kind: "room",
          labelKey: "bell.item.code",
          params: { room },
          path: "/tonight",
        });
        break;
      case "late":
        items.push({
          key: `room:late:${String(a["booking_id"])}`,
          kind: "room",
          labelKey: "bell.item.late",
          params: { room },
          path: "/tonight",
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
    });
  for (const c of s.conversations ?? [])
    if (c.unread > 0)
      items.push({
        key: `text:${c.id}:${c.last_inbound_at ?? ""}`,
        kind: "text",
        labelKey: "bell.item.text",
        params: { count: c.unread },
        path: "/messages",
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
