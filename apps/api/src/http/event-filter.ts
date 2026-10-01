import type { StampedEvent } from "@west4/db";
import type { Principal } from "./principal.js";

/**
 * What a socket may see (spec 02 · Who can call what; spec 08 · Live events).
 * A room tablet or a guest in a room gets only its room's channel; a locked
 * shared device only ring state; an Up next display only the queue;
 * managers' events reach managers and owners; a person's own events reach
 * only them.
 */
export interface Subscription {
  readonly principal: Principal;
  readonly venueId: string;
  /** A shared device with nobody signed in: room numbers and ring state only. */
  readonly locked?: boolean;
  /** The room a tablet or a guest is bound to. */
  readonly roomId?: string | undefined;
}

const RING_STATE_TYPES: ReadonlySet<string> = new Set([
  "order.ringing",
  "order.held",
  "order.accepted",
  "order.cancelled",
  "room.call",
]);
const DISPLAY_TYPES: ReadonlySet<string> = new Set(["song_queue.updated"]);

export function visibleTo(
  sub: Subscription,
  event: Pick<StampedEvent, "venue_id" | "type" | "room_id" | "audience" | "user_id">,
): boolean {
  if (event.venue_id !== sub.venueId) return false;
  const p = sub.principal;
  switch (p.kind) {
    case "user": {
      const membership = p.memberships.find((m) => m.venueId === sub.venueId);
      if (!membership) return false;
      const manager = membership.role === "owner" || membership.role === "manager";
      if (event.audience === "managers") return manager;
      if (event.audience === "user") return event.user_id === p.userId;
      if (event.audience === "display") return true;
      return true;
    }
    case "device": {
      if (p.venueId !== sub.venueId) return false;
      if (p.deviceKind === "room_tablet")
        return (
          event.audience !== "managers" &&
          event.audience !== "user" &&
          event.room_id !== null &&
          event.room_id === (sub.roomId ?? null)
        );
      if (p.deviceKind === "up_next_display") return DISPLAY_TYPES.has(event.type);
      if (p.deviceKind === "printer") return false;
      // bar computer or front desk
      if (sub.locked) return RING_STATE_TYPES.has(event.type);
      return event.audience !== "managers" && event.audience !== "user";
    }
    case "guest":
      return (
        p.venueId === sub.venueId &&
        p.scope === "room_session" &&
        event.room_id !== null &&
        event.room_id === (sub.roomId ?? null) &&
        event.audience !== "managers" &&
        event.audience !== "user" &&
        event.audience !== "staff"
      );
    case "singer":
      return p.venueId === sub.venueId && DISPLAY_TYPES.has(event.type);
    case "support":
      return p.venueId === sub.venueId && event.audience !== "user";
    case "console": // the Console reads venues over HTTP; it has no live socket in phase 1
    case "anonymous":
    case "webhook":
      return false;
  }
}
