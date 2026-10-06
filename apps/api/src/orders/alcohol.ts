import type { FastifyRequest } from "fastify";
import { readSetting, rulePackFor, withVenue, type Queryable } from "@west4/db";
import { alcoholWindow, businessDate, type AlcoholVenue } from "@west4/rules";
import { builtInRulePacks, type Temporal } from "@west4/shared";
import type pg from "pg";
import { ApiError } from "../http/errors.js";
import { venueClock } from "../rooms/assignment.js";

/**
 * The one alcohol check (M3-20; Money rules 5; spec 03 · The alcohol window):
 * an alcohol line may be created only while the window is open and neither
 * the room nor the guest it's for is cut off. Every route that creates one
 * runs it (guest and host orders, staff orders, Same again) and Accept runs
 * it again. A refusal answers `409 alcohol_closed` or `409 cut_off` and is
 * logged in `alcohol_refusals`, in its own transaction once the refused one
 * has rolled back.
 */
export interface Refused {
  readonly reason: "window_closed" | "cut_off";
  readonly sessionId: string | null;
  readonly checkId: string | null;
  readonly roomGuestId: string | null;
  readonly orderId: string | null;
  readonly refusedBy: string | null;
  readonly items: readonly string[];
  readonly at: string;
  readonly businessDate: string;
}

export class AlcoholRefused extends ApiError {
  /** `extra` adds to the details: a move names the cut-off's reason (M6-13). */
  constructor(
    readonly refused: Refused,
    extra: Record<string, unknown> = {},
  ) {
    super(
      refused.reason === "cut_off" ? "cut_off" : "alcohol_closed",
      refused.reason === "cut_off"
        ? "alcohol is paused for this room"
        : "the bar has stopped serving alcohol",
      { details: { reason: refused.reason, items: refused.items, ...extra } },
    );
  }
}

/** The venue's alcohol window inputs: the pack's alcohol rules and the house last call. */
export async function alcoholVenue(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
): Promise<AlcoholVenue> {
  const v = await venueClock(c, venueId);
  const date = businessDate(now, v.timeZone, v.dayCutover).businessDate;
  const venue = await c.query<{ rule_pack_id: string | null }>(
    "select rule_pack_id from venues where id = $1",
    [venueId],
  );
  const packId = venue.rows[0]?.rule_pack_id ?? "us-ny-new-york-county";
  // The published pack; the built-in one with the same id stands in where none is published (tests, a fresh install).
  const pack =
    (await rulePackFor(c, packId, date))?.pack ??
    builtInRulePacks.find((p) => p.id === packId) ??
    builtInRulePacks[0]!;
  const hours = await readSetting(c, venueId, "hours", date);
  return {
    timeZone: v.timeZone,
    dayCutover: v.dayCutover,
    alcohol: { ...builtInRulePacks[0]!.alcohol, ...pack.alcohol },
    lastCall: hours?.value.lastCall ?? null,
  };
}

/** The window now and when it next changes, for every screen to change at the same moment. */
export async function alcoholNow(c: Queryable, venueId: string, now: Temporal.Instant) {
  const w = alcoholWindow(await alcoholVenue(c, venueId, now), now);
  return { state: w.state, changes_at: w.changesAt.toString(), closes_at: w.closesAt.toString() };
}

/** Why alcohol is refused for this session and guest right now, or null when it may be sold. */
export async function alcoholBlock(
  c: Queryable,
  venueId: string,
  who: { sessionId: string | null; roomGuestId: string | null },
  now: Temporal.Instant,
): Promise<"window_closed" | "cut_off" | null> {
  if ((await alcoholNow(c, venueId, now)).state === "closed") return "window_closed";
  if (who.sessionId) {
    const s = await c.query<{ cut: boolean }>(
      "select alcohol_cut_off_at is not null as cut from room_sessions where venue_id = $1 and id = $2",
      [venueId, who.sessionId],
    );
    if (s.rows[0]?.cut) return "cut_off";
  }
  if (who.roomGuestId) {
    const g = await c.query<{ cut: boolean }>(
      "select alcohol_cut_off_at is not null as cut from room_guests where venue_id = $1 and id = $2",
      [venueId, who.roomGuestId],
    );
    if (g.rows[0]?.cut) return "cut_off";
  }
  return null;
}

/** Runs the check on an order's items; throws AlcoholRefused when alcohol may not be sold. */
export async function checkAlcohol(
  c: Queryable,
  venueId: string,
  input: {
    items: readonly { name: string; alcohol: boolean }[];
    sessionId: string | null;
    checkId: string | null;
    roomGuestId: string | null;
    orderId?: string | null;
    refusedBy: string | null;
    now: Temporal.Instant;
  },
): Promise<void> {
  const alcohol = input.items.filter((i) => i.alcohol);
  if (alcohol.length === 0) return;
  const block = await alcoholBlock(c, venueId, input, input.now);
  if (!block) return;
  const v = await venueClock(c, venueId);
  throw new AlcoholRefused({
    reason: block,
    sessionId: input.sessionId,
    checkId: input.checkId,
    roomGuestId: input.roomGuestId,
    orderId: input.orderId ?? null,
    refusedBy: input.refusedBy,
    items: alcohol.map((i) => i.name),
    at: input.now.toString(),
    businessDate: businessDate(input.now, v.timeZone, v.dayCutover).businessDate.toString(),
  });
}

async function logRefused(c: Queryable, venueId: string, r: Refused) {
  for (const item of r.items)
    await c.query(
      `insert into alcohol_refusals (venue_id, session_id, check_id, room_guest_id, order_id, reason, item, refused_by, at, business_date)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        venueId,
        r.sessionId,
        r.checkId,
        r.roomGuestId,
        r.orderId,
        r.reason,
        item,
        r.refusedBy,
        r.at,
        r.businessDate,
      ],
    );
}

/** A venue transaction whose alcohol refusal is logged after it rolls back, then answered. */
export async function inVenueRefusing<T>(
  request: FastifyRequest,
  work: (c: Queryable) => Promise<T>,
): Promise<T> {
  try {
    return await request.inVenue(work);
  } catch (e) {
    if (e instanceof AlcoholRefused)
      await request.inVenue((c) => logRefused(c, request.venueId!, e.refused));
    throw e;
  }
}

export async function withVenueRefusing<T>(
  pool: pg.Pool,
  ctx: { venueId: string; requestId?: string },
  work: (c: Queryable) => Promise<T>,
): Promise<T> {
  try {
    return await withVenue(pool, ctx, work);
  } catch (e) {
    if (e instanceof AlcoholRefused)
      await withVenue(pool, ctx, (c) => logRefused(c, ctx.venueId, e.refused));
    throw e;
  }
}
