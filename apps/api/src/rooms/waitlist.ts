import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import {
  addBlock,
  blocksBetween,
  emitEvent,
  endWaitlistEntry,
  findOrCreateGuest,
  insertWaitlistEntry,
  listRooms,
  liveWaitlist,
  readSetting,
  releaseBlock,
  RoomNotFree,
  waitlistEntry,
  withVenue,
  type Queryable,
  type Sweep,
  type WaitlistRow,
} from "@west4/db";
import { businessDate, minGuestsOn } from "@west4/rules";
import { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { freeFor, nightOf, venueClock } from "./assignment.js";
import { queueText } from "../texts/queue.js";
import type { VenueTextSettings } from "../texts/venue.js";

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
  texts?: Pick<VenueTextSettings, "allowList">,
): Promise<void> {
  const entry = await waitlistEntry(c, venueId, id);
  if (!entry) throw new ApiError("not_found", "no such party on the waitlist");
  if (status === "declined" && entry.status !== "offered")
    throw new ApiError("invalid_request", "there's no offer to give away");
  if (!(await endWaitlistEntry(c, venueId, id, status, now.toString())))
    throw new ApiError("invalid_request", "that party isn't waiting any more");
  await emitEvent(c, { venueId, type: "waitlist.updated", entityId: id, entityVersion: 0 });
  // An offer given away or taken off: the room goes to the next party that fits (M2-26).
  if (entry.status === "offered" && entry.offered_room_id) {
    await releaseHold(c, venueId, id);
    if (texts) await offerToNext(c, venueId, entry.offered_room_id, now, texts);
  }
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
        ? {
            room_name: entry.offered_room_name,
            expires_at: entry.offer_expires_at,
            // Counted on the server's clock, so the page's countdown never trusts the phone's.
            seconds_left: entry.offer_expires_at
              ? Math.max(
                  0,
                  Math.ceil(
                    (Temporal.Instant.from(entry.offer_expires_at).epochMilliseconds -
                      now.epochMilliseconds) /
                      1000,
                  ),
                )
              : null,
          }
        : null,
  };
}

export const OFFER_HOLD_MIN = 10;
const FREE_FOR_MIN = 60;

/**
 * The room an offer takes (M2-26; spec 04 · Room assignment): the smallest
 * that fits and is free for an hour, or a bigger one that no booking tonight
 * needs. A room being cleaned isn't offered.
 */
export async function pickOfferRoom(
  c: Queryable,
  venueId: string,
  party: number,
  now: Temporal.Instant,
  only?: string,
): Promise<{ id: string; name: string } | null> {
  const free = await freeFor(c, venueId, {
    party,
    from: now,
    to: now.add({ minutes: FREE_FOR_MIN }),
    now,
  });
  const rooms = await listRooms(c, venueId);
  const needed = await tierFor(c, venueId, party);
  const order = ["small", "medium", "large", "vip"];
  const venue = await venueClock(c, venueId);
  const night = await nightOf(c, venueId, venue, now);
  // After the night's close there's nothing left of tonight to offer (and no range to read).
  const end = night.close ?? now.add({ hours: 12 });
  if (Temporal.Instant.compare(end, now) <= 0) return null;
  const tonight = await blocksBetween(c, venueId, now, end);
  for (const r of free.rooms) {
    if (only && r.room_id !== only) continue;
    const room = rooms.find((x) => x.id === r.room_id);
    if (!room) continue;
    if (order.indexOf(room.size_tier) > order.indexOf(needed)) {
      const needs = tonight.some(
        (b) => b.room_id === room.id && (b.kind === "booking" || b.kind === "hold"),
      );
      if (needs) continue;
    }
    return { id: room.id, name: room.name };
  }
  return null;
}

async function releaseHold(c: Queryable, venueId: string, entryId: string) {
  const holds = await c.query<{ id: string; room_id: string }>(
    "select id, room_id from room_blocks where venue_id = $1 and ref_id = $2 and kind = 'hold'",
    [venueId, entryId],
  );
  for (const h of holds.rows) {
    await releaseBlock(c, h.id);
    await emitEvent(c, { venueId, type: "room.updated", entityId: h.room_id, entityVersion: 0 });
  }
}

/**
 * Offers a waiting party a room: a hold that expires in 10 minutes, the Room
 * ready text (its message kept, so a failure shows "Not delivered · Call"),
 * and the countdown everywhere. `roomId` offers that room only.
 */
export async function offerRoom(
  c: Queryable,
  venueId: string,
  entryId: string,
  input: { now: Temporal.Instant; roomId?: string },
  texts: Pick<VenueTextSettings, "allowList">,
) {
  const entry = await waitlistEntry(c, venueId, entryId);
  if (!entry) throw new ApiError("not_found", "no such party on the waitlist");
  if (entry.status !== "waiting")
    throw new ApiError("invalid_request", "that party isn't waiting for a room");
  const room = await pickOfferRoom(c, venueId, entry.party_size, input.now, input.roomId);
  if (!room)
    throw new ApiError("room_not_free", "no room fits this party for an hour", {
      details: { reason: "no_room" },
    });
  const expires = input.now.add({ minutes: OFFER_HOLD_MIN });
  try {
    await addBlock(c, {
      venueId,
      roomId: room.id,
      kind: "hold",
      from: input.now,
      to: expires,
      expiresAt: expires,
      refId: entryId,
    });
  } catch (e) {
    if (e instanceof RoomNotFree)
      throw new ApiError("room_not_free", `${room.name} was just taken`, {
        details: { reason: "taken" },
      });
    throw e;
  }
  let messageId: string | null = null;
  if (entry.phone_e164)
    try {
      messageId = (
        await queueText(
          c,
          venueId,
          {
            templateKey: "room_ready",
            to: entry.phone_e164,
            params: { room: room.name },
            guestId: entry.guest_id,
            context: { kind: "waitlist", id: entryId },
            sentBy: null,
            now: input.now,
          },
          texts,
        )
      ).messageId;
    } catch (e) {
      // A text that can't go never blocks the offer: the row shows "Not delivered · Call".
      if (!(e instanceof ApiError)) throw e;
    }
  await c.query(
    `update waitlist_entries set status = 'offered', offered_room_id = $3, offer_expires_at = $4, offer_message_id = $5
      where venue_id = $1 and id = $2`,
    [venueId, entryId, room.id, expires.toString(), messageId],
  );
  await emitEvent(c, { venueId, type: "waitlist.updated", entityId: entryId, entityVersion: 0 });
  await emitEvent(c, { venueId, type: "room.updated", entityId: room.id, entityVersion: 0 });
  return {
    room_id: room.id,
    room_name: room.name,
    offer_expires_at: expires.toString(),
    message_id: messageId,
  };
}

/** The room goes to the next waiting party that fits it, if the room is still free for an hour. */
async function offerToNext(
  c: Queryable,
  venueId: string,
  roomId: string,
  now: Temporal.Instant,
  texts: Pick<VenueTextSettings, "allowList">,
) {
  const room = (await listRooms(c, venueId)).find((r) => r.id === roomId);
  if (!room) return null;
  for (const next of await liveWaitlist(c, venueId)) {
    if (next.status !== "waiting" || next.party_size > room.capacity_max) continue;
    if (!(await pickOfferRoom(c, venueId, next.party_size, now, roomId))) continue;
    return offerRoom(c, venueId, next.id, { now, roomId }, texts);
  }
  return null;
}

/** Offers not taken in 10 minutes expire: the hold goes and the room is offered to the next party that fits. */
export async function expireOffers(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
  texts: Pick<VenueTextSettings, "allowList">,
): Promise<string[]> {
  const due = await c.query<{ id: string; room_id: string }>(
    `select id, offered_room_id as room_id from waitlist_entries
      where venue_id = $1 and status = 'offered' and offer_expires_at <= $2::timestamptz order by offer_expires_at`,
    [venueId, now.toString()],
  );
  for (const e of due.rows) {
    await endWaitlistEntry(c, venueId, e.id, "expired", now.toString());
    await releaseHold(c, venueId, e.id);
    await emitEvent(c, { venueId, type: "waitlist.updated", entityId: e.id, entityVersion: 0 });
    if (e.room_id) await offerToNext(c, venueId, e.room_id, now, texts);
  }
  return due.rows.map((r) => r.id);
}

/** The board's lime alert: the first waiting party and the room an offer would take now. */
export async function offerSuggestion(c: Queryable, venueId: string, now: Temporal.Instant) {
  for (const w of await liveWaitlist(c, venueId)) {
    if (w.status !== "waiting") continue;
    const room = await pickOfferRoom(c, venueId, w.party_size, now);
    if (room)
      return {
        entry_id: w.id,
        name: w.name,
        party_size: w.party_size,
        room_id: room.id,
        room_name: room.name,
      };
  }
  return null;
}

export async function sweepWaitlistOffers(
  pool: pg.Pool,
  now: Temporal.Instant,
  texts: Pick<VenueTextSettings, "allowList">,
) {
  const venues = await pool.query<{ id: string }>("select id from venues_for_scheduler()");
  const out: { venueId: string; expired: string[] }[] = [];
  for (const v of venues.rows) {
    const expired = await withVenue(pool, { venueId: v.id, requestId: "sweep:waitlist" }, (c) =>
      expireOffers(c, v.id, now, texts),
    );
    if (expired.length > 0) out.push({ venueId: v.id, expired });
  }
  return out;
}

export function waitlistOfferSweep(
  pool: pg.Pool,
  texts: Pick<VenueTextSettings, "allowList">,
): Sweep {
  return {
    name: "waitlist-offers",
    everyMs: 30_000,
    run: async (now) => void (await sweepWaitlistOffers(pool, now, texts)),
  };
}
