import { createHash, randomBytes } from "node:crypto";
import {
  emitEvent,
  endWaitlistEntry,
  findOrCreateGuest,
  insertWaitlistEntry,
  listRooms,
  liveWaitlist,
  readSetting,
  waitlistEntry,
  type Queryable,
  type WaitlistRow,
} from "@west4/db";
import { businessDate, minGuestsOn } from "@west4/rules";
import { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { venueClock } from "./assignment.js";

/**
 * The walk-in waitlist (M2-25; screens N11 and Waitlist; spec 04 ·
 * waitlist_entries). Staff add parties from the drawer; guests join from the
 * door QR and follow their place behind a link token (128 bits, stored hashed,
 * expiring at the night's cutover).
 */
const US = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** The smallest room size that fits the party: the VIP room only when no other does. */
export async function tierFor(c: Queryable, venueId: string, party: number): Promise<string> {
  const rooms = (await listRooms(c, venueId)).filter((r) => !r.archived_at);
  const fit = rooms
    .filter((r) => r.capacity_max >= party)
    .sort((a, b) => Number(a.is_vip) - Number(b.is_vip) || a.capacity_max - b.capacity_max)[0];
  if (!fit) throw new ApiError("invalid_request", "no room here fits a party that size");
  return fit.size_tier;
}

/** "bills as 4 on Friday": the business date's minimum, and which day it is. */
async function billing(c: Queryable, venueId: string, party: number, now: Temporal.Instant) {
  const venue = await venueClock(c, venueId);
  const date = businessDate(now, venue.timeZone, venue.dayCutover).businessDate;
  const prices = await readSetting(c, venueId, "prices", date);
  const min = prices ? minGuestsOn(date, prices.value) : 0;
  return {
    date,
    billsAs: Math.max(party, min),
    day: date.dayOfWeek,
    cutover: Temporal.ZonedDateTime.from({
      timeZone: venue.timeZone,
      year: date.year,
      month: date.month,
      day: date.day,
      hour: Number(venue.dayCutover.slice(0, 2)),
      minute: Number(venue.dayCutover.slice(3, 5)),
    })
      .add({ days: 1 })
      .toInstant(),
  };
}

export interface StaffEntry extends WaitlistRow {
  readonly bills_as: number;
  readonly waited_min: number;
}

export async function staffWaitlist(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
): Promise<StaffEntry[]> {
  const rows = await liveWaitlist(c, venueId);
  const b = await billing(c, venueId, 0, now);
  return rows.map((w) => ({
    ...w,
    bills_as: Math.max(w.party_size, b.billsAs),
    waited_min: Math.max(
      0,
      Math.floor(
        (now.epochMilliseconds - Temporal.Instant.from(w.joined_at).epochMilliseconds) / 60_000,
      ),
    ),
  }));
}

export async function joinWaitlist(
  c: Queryable,
  venueId: string,
  input: {
    name: string;
    phone: string;
    partySize: number;
    quotedMin: number | null;
    source: "staff" | "door";
    now: Temporal.Instant;
  },
): Promise<{ entryId: string; token: string | null }> {
  if (!US.test(input.phone))
    throw new ApiError("invalid_request", "a US mobile number, please", {
      details: { reason: "phone" },
    });
  const tier = await tierFor(c, venueId, input.partySize);
  const guestId = await findOrCreateGuest(c, venueId, { name: input.name, phoneE164: input.phone });
  const already = await c.query<{ id: string }>(
    "select id from waitlist_entries where venue_id = $1 and guest_id = $2 and status in ('waiting', 'offered')",
    [venueId, guestId],
  );
  if (already.rows[0])
    throw new ApiError("invalid_request", "that number is already on the waitlist", {
      details: { reason: "already_waiting" },
    });
  const b = await billing(c, venueId, input.partySize, input.now);
  const token = input.source === "door" ? randomBytes(16).toString("base64url") : null;
  const entryId = await insertWaitlistEntry(c, venueId, {
    guestId,
    partySize: input.partySize,
    sizeTierNeeded: tier,
    joinedAt: input.now.toString(),
    quotedMin: input.quotedMin,
    source: input.source,
    linkTokenHash: token ? hashToken(token) : null,
    linkExpiresAt: token ? b.cutover.toString() : null,
  });
  await emitEvent(c, { venueId, type: "waitlist.updated", entityId: entryId, entityVersion: 0 });
  return { entryId, token };
}

/** Takes a party off every screen: removed by staff, or left or declined by the guest. */
export async function endEntry(
  c: Queryable,
  venueId: string,
  id: string,
  status: "left" | "declined",
  now: Temporal.Instant,
): Promise<void> {
  const entry = await waitlistEntry(c, venueId, id);
  if (!entry) throw new ApiError("not_found", "no such party on the waitlist");
  if (status === "declined" && entry.status !== "offered")
    throw new ApiError("invalid_request", "there's no offer to give away");
  if (!(await endWaitlistEntry(c, venueId, id, status, now.toString())))
    throw new ApiError("invalid_request", "that party isn't waiting any more");
  await emitEvent(c, { venueId, type: "waitlist.updated", entityId: id, entityVersion: 0 });
}

/** The guest's page: their place from the live list, the quote once staff set one, and any offer. */
export async function guestView(c: Queryable, venueId: string, id: string, now: Temporal.Instant) {
  const entry = await waitlistEntry(c, venueId, id);
  if (!entry) throw new ApiError("not_found", "no such waitlist spot");
  const venue = (
    await c.query<{ name: string }>("select name from venues where id = $1", [venueId])
  ).rows[0]!;
  const b = await billing(c, venueId, entry.party_size, now);
  const live = entry.status === "waiting" || entry.status === "offered";
  return {
    venue_name: venue.name,
    name: entry.name,
    party_size: entry.party_size,
    bills_as: b.billsAs,
    day_of_week: b.day,
    status: entry.status,
    ahead: live ? entry.ahead : null,
    quoted_min: entry.quoted_min,
    joined_at: entry.joined_at,
    offer:
      entry.status === "offered" && entry.offered_room_name
        ? { room_name: entry.offered_room_name, expires_at: entry.offer_expires_at }
        : null,
  };
}
