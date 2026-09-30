import type { DeviceKind } from "@west4/db";
/**
 * Who is calling (spec 02 · Who can call what). Each authenticator (device
 * signatures in M1-15, passkeys in M1-19, PIN and badge in M1-24 and M1-25,
 * guest tokens in M2 to M5) sets request.principal; until one does, the
 * caller is anonymous.
 */
export type PrincipalName =
  | "owner_manager"
  | "staff"
  | "shared_device"
  | "room_tablet"
  | "guest_room"
  | "guest_booking"
  | "guest_link"
  | "singer"
  | "printer"
  | "up_next_display"
  | "support"
  | "webhook"
  | "public";

export type StaffRole = "owner" | "manager" | "bartender" | "front_desk" | "staff";
export type SessionKind = "passkey" | "pin" | "badge";

export type Principal =
  | { readonly kind: "anonymous" }
  | {
      readonly kind: "user";
      readonly userId: string;
      readonly session: SessionKind;
      readonly memberships: readonly {
        readonly venueId: string;
        readonly membershipId: string;
        readonly role: StaffRole;
      }[];
    }
  | {
      readonly kind: "device";
      readonly deviceId: string;
      readonly venueId: string;
      readonly deviceKind:
        "bar_computer" | "front_desk" | "room_tablet" | "printer" | "up_next_display";
    }
  | {
      readonly kind: "guest";
      readonly venueId: string;
      readonly scope: "room_session" | "booking" | "link";
      readonly id: string;
    }
  | { readonly kind: "singer"; readonly venueId: string; readonly singerId: string }
  | {
      readonly kind: "support";
      readonly staffId: string;
      readonly grantId: string;
      readonly venueId: string;
    }
  | { readonly kind: "webhook"; readonly provider: "stripe" | "twilio" };

export const ANONYMOUS: Principal = { kind: "anonymous" };

/**
 * The device whose signature this request carried, whatever its kind: set by
 * the device authenticator even for kinds that don't act as a principal (a
 * staff phone, a router), so the heartbeat route knows who checked in.
 */
export interface SignedDevice {
  readonly deviceId: string;
  readonly venueId: string;
  readonly kind: DeviceKind;
}

/** Does this caller count as one of the principal names a route declares? */
export function principalIs(p: Principal, name: PrincipalName, venueId?: string): boolean {
  const atVenue = (id: string) => venueId === undefined || id === venueId;
  switch (name) {
    case "public":
      return true;
    case "owner_manager":
      return (
        p.kind === "user" &&
        p.session === "passkey" &&
        p.memberships.some(
          (m) => atVenue(m.venueId) && (m.role === "owner" || m.role === "manager"),
        )
      );
    case "staff":
      return p.kind === "user" && p.memberships.some((m) => atVenue(m.venueId));
    case "shared_device":
      return (
        p.kind === "device" &&
        atVenue(p.venueId) &&
        (p.deviceKind === "bar_computer" || p.deviceKind === "front_desk")
      );
    case "room_tablet":
      return p.kind === "device" && atVenue(p.venueId) && p.deviceKind === "room_tablet";
    case "printer":
      return p.kind === "device" && atVenue(p.venueId) && p.deviceKind === "printer";
    case "up_next_display":
      return p.kind === "device" && atVenue(p.venueId) && p.deviceKind === "up_next_display";
    case "guest_room":
      return p.kind === "guest" && atVenue(p.venueId) && p.scope === "room_session";
    case "guest_booking":
      return p.kind === "guest" && atVenue(p.venueId) && p.scope === "booking";
    case "guest_link":
      return p.kind === "guest" && atVenue(p.venueId) && p.scope === "link";
    case "singer":
      return p.kind === "singer" && atVenue(p.venueId);
    case "support":
      return p.kind === "support" && atVenue(p.venueId);
    case "webhook":
      return p.kind === "webhook";
  }
}

/** A stable id for idempotency keys and audit: who, not which session. */
export function principalId(p: Principal): string {
  switch (p.kind) {
    case "anonymous":
      return "anonymous";
    case "user":
      return `user:${p.userId}`;
    case "device":
      return `device:${p.deviceId}`;
    case "guest":
      return `guest:${p.scope}:${p.id}`;
    case "singer":
      return `singer:${p.singerId}`;
    case "support":
      return `support:${p.staffId}:${p.grantId}`;
    case "webhook":
      return `webhook:${p.provider}`;
  }
}
