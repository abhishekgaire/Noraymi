import type { FastifyRequest } from "fastify";
import { trainingOf, type Queryable } from "@west4/db";
import { ApiError } from "./errors.js";

/**
 * Training mode on the API (M7-03; API · Conventions, Training mode). The
 * request is marked once, from the signed-in person's membership and the
 * device it comes from. Then the wall between practice and live work: a live
 * caller can't see or touch a practice check, session, tab, order or payment,
 * and a trainee can't change a live one (403 forbidden). Practice work never counts,
 * so the wall is what keeps a trainee's practice out of real money.
 */
declare module "fastify" {
  interface FastifyRequest {
    /** Is this request practice: the person or the device is in training mode? */
    training: boolean;
  }
}

/** The person's membership here and every device the request came through. */
export async function markTraining(
  request: FastifyRequest,
  c: Queryable,
  venueId: string,
): Promise<boolean> {
  const p = request.principal;
  if (p.kind !== "user" && p.kind !== "device") return false;
  const membershipId =
    p.kind === "user"
      ? (p.memberships.find((m) => m.venueId === venueId)?.membershipId ?? null)
      : null;
  return trainingOf(c, venueId, {
    membershipId,
    deviceIds: [
      p.kind === "device" ? p.deviceId : null,
      request.session?.deviceId,
      request.signedDevice?.deviceId,
    ],
  });
}

const BY_PARAM: Record<string, string> = {
  checkId: "select training from checks where venue_id = $1 and id = $2",
  sessionId: "select training from room_sessions where venue_id = $1 and id = $2",
  t: `select k.training from tabs t join checks k on k.venue_id = t.venue_id and k.id = t.check_id
       where t.venue_id = $1 and t.id = $2`,
  orderId: `select k.training from orders o join checks k on k.venue_id = o.venue_id and k.id = o.check_id
             where o.venue_id = $1 and o.id = $2`,
  paymentId: "select training from payments where venue_id = $1 and id = $2",
  splitId: `select k.training from check_splits s join checks k on k.venue_id = s.venue_id and k.id = s.check_id
             where s.venue_id = $1 and s.id = $2`,
};
const OPENING =
  "select p.training from tab_openings o join payments p on p.venue_id = o.venue_id and p.id = o.payment_id where o.venue_id = $1 and o.id = $2";

/** Body fields that point at work another route owns: a tab moved to a room, a line moved to a tab. */
const BY_BODY: Record<string, string> = {
  check_id: BY_PARAM.checkId!,
  session_id: BY_PARAM.sessionId!,
  tab_id: BY_PARAM.t!,
};

/**
 * Routes a trainee never calls, whatever they point at (cautious default, the
 * ticket's notes): checking in a real booking, marking it a no-show, seating
 * a real waitlist party, changing a live room's state, and selling a singer
 * real song credits.
 */
const LIVE_ONLY = [
  /^\/v1\/venues\/:venueId\/bookings\/:bookingId\/(check-in|no-show)$/,
  /^\/v1\/venues\/:venueId\/waitlist\/:w\/seat$/,
  /^\/v1\/venues\/:venueId\/rooms\/:r\/(state|clean)$/,
  // Song credits are a guest's real prepaid money, sold in cash at the drawer.
  /^\/v1\/venues\/:venueId\/singers\/:s\/credits$/,
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Throws 403 when the request and the work it touches are on different sides of the wall. */
export async function guardTraining(
  request: FastifyRequest,
  c: Queryable,
  venueId: string,
): Promise<void> {
  const p = request.principal;
  if (p.kind !== "user" && p.kind !== "device") return;
  const url = request.routeOptions.url ?? "";
  const write = request.method !== "GET" && request.method !== "HEAD";
  if (request.training && write && LIVE_ONLY.some((r) => r.test(url)))
    throw new ApiError("forbidden", "in training you can't change live work", {
      details: { reason: "training" },
    });
  const lookups: { sql: string; id: string }[] = [];
  const params = (request.params ?? {}) as Record<string, string | undefined>;
  for (const [name, sql] of Object.entries(BY_PARAM)) {
    const id = params[name];
    if (id && UUID.test(id)) lookups.push({ sql, id });
  }
  if (params.o && UUID.test(params.o) && url.includes("/tabs/openings/"))
    lookups.push({ sql: OPENING, id: params.o });
  if (write && request.body && typeof request.body === "object") {
    const body = request.body as Record<string, unknown>;
    for (const [field, sql] of Object.entries(BY_BODY)) {
      const id = body[field];
      if (typeof id === "string" && UUID.test(id)) lookups.push({ sql, id });
    }
  }
  for (const { sql, id } of lookups) {
    const r = await c.query<{ training: boolean }>(sql, [venueId, id]);
    const row = r.rows[0];
    // A trainee may look at live work (the board, a real room); only a write touches it.
    if (row && row.training !== request.training && (write || !request.training))
      throw new ApiError(
        "forbidden",
        request.training ? "in training you can't touch a live check" : "that's practice work",
        { details: { reason: "training" } },
      );
  }
}
