import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { openShifts, recordPunch, ShiftError, type Queryable, type ShiftRow } from "@west4/db";
import { DUTIES, dutiesFor, type Duty, type PunchKind } from "@west4/rules";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { venueClock } from "../rooms/assignment.js";

/**
 * The time clock (M7-01; spec 08 · Time clock). Staff clock in with a duty,
 * take breaks and clock out after a badge tap or name and PIN on a shared
 * screen, or their own PIN on their phone: the signed-in session is the
 * person punching. Each punch rebuilds its shift in the same transaction.
 * With Team, time clock & tips off, every route answers 404 module_off.
 * M7-11 adds the clock-out checklist and punch edits.
 */
export interface ShiftView {
  readonly id: string;
  readonly duty: Duty;
  readonly business_date: string;
  readonly started_at: string;
  readonly break_minutes: number;
  readonly break_started_at: string | null;
  readonly punches: readonly { readonly kind: PunchKind; readonly at: string }[];
}

export function shiftView(s: ShiftRow): ShiftView {
  return {
    id: s.id,
    duty: s.duty,
    business_date: s.business_date,
    started_at: s.started_at,
    break_minutes: s.break_minutes,
    break_started_at: s.break_started_at,
    punches: s.punches.map((p) => ({ kind: p.kind, at: p.at })),
  };
}

/** Everyone at the venue with their open shift, or null when they're not on shift. */
export async function teamOnTheClock(
  c: Queryable,
  venueId: string,
): Promise<{ membership_id: string; name: string; role: string; shift: ShiftView | null }[]> {
  const people = await c.query<{ membership_id: string; name: string; role: string }>(
    `select m.id as membership_id, u.name, m.role from memberships m join users u on u.id = m.user_id
      where m.venue_id = $1 and m.status = 'active'
      order by array_position(array['owner','manager','bartender','front_desk','staff'], m.role), u.name`,
    [venueId],
  );
  const open = new Map((await openShifts(c, venueId)).map((s) => [s.membership_id, s]));
  return people.rows.map((p) => {
    const s = open.get(p.membership_id);
    return { ...p, shift: s ? shiftView(s) : null };
  });
}

const refusal = (e: unknown): never => {
  if (e instanceof ShiftError)
    throw new ApiError(
      e.refusal === "no_duty" ? "invalid_request" : "version_conflict",
      e.message,
      {
        details: { refusal: e.refusal },
      },
    );
  throw e;
};

export function shiftRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  const staff = route({ principals: ["owner_manager", "staff"], module: "team" });
  const write = route({
    principals: ["owner_manager", "staff"],
    module: "team",
    idempotency: "optional",
  });

  const me = (request: FastifyRequest) => {
    const p = request.principal;
    if (p.kind !== "user") throw new ApiError("forbidden", "a person clocks in");
    const m = p.memberships.find((x) => x.venueId === request.venueId);
    if (!m) throw new ApiError("forbidden", "not at this venue");
    return m;
  };
  const deviceOf = (request: FastifyRequest) =>
    request.signedDevice && request.signedDevice.venueId === request.venueId
      ? request.signedDevice.deviceId
      : null;

  const punch = (request: FastifyRequest, kind: PunchKind, duty?: Duty) => {
    const m = me(request);
    return request.inVenue(async (c) => {
      const venue = await venueClock(c, request.venueId!);
      const shift = await recordPunch(c, {
        venueId: request.venueId!,
        membershipId: m.membershipId,
        kind,
        ...(duty ? { duty } : {}),
        at: options.clock.now(),
        deviceId: deviceOf(request),
        venue,
      }).catch(refusal);
      return { shift: shiftView(shift) };
    });
  };

  // Who's on the clock, and the signed-in person's own shift and duties.
  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/shifts",
    { config: staff },
    async (request) => {
      const m = me(request);
      return request.inVenue(async (c) => {
        const team = await teamOnTheClock(c, request.venueId!);
        const mine = team.find((t) => t.membership_id === m.membershipId);
        return {
          server_time: options.clock.now().toString(),
          me: {
            membership_id: m.membershipId,
            duties: dutiesFor(m.role),
            shift: mine?.shift ?? null,
          },
          team,
        };
      });
    },
  );

  const clockInBody = z.object({ duty: z.enum(DUTIES as [Duty, ...Duty[]]) }).strict();
  app.post<{ Params: { venueId: string }; Body: unknown }>(
    "/v1/venues/:venueId/shifts/clock-in",
    { config: write },
    async (request, reply) => {
      const parsed = clockInBody.safeParse(request.body ?? {});
      if (!parsed.success)
        throw new ApiError(
          "invalid_request",
          "clock-in needs a duty: bar, front_desk, runner or manager",
        );
      const m = me(request);
      if (!dutiesFor(m.role).includes(parsed.data.duty))
        throw new ApiError("forbidden", "the Manager duty is for owners and managers");
      const answer = await punch(request, "clock_in", parsed.data.duty);
      return reply.code(201).send(answer);
    },
  );

  const breakBody = z.object({ action: z.enum(["start", "end"]) }).strict();
  app.post<{ Params: { venueId: string }; Body: unknown }>(
    "/v1/venues/:venueId/shifts/break",
    { config: write },
    async (request) => {
      const parsed = breakBody.safeParse(request.body ?? {});
      if (!parsed.success)
        throw new ApiError("invalid_request", "send { action: 'start' | 'end' }");
      return punch(request, parsed.data.action === "start" ? "break_start" : "break_end");
    },
  );

  app.post<{ Params: { venueId: string }; Body: unknown }>(
    "/v1/venues/:venueId/shifts/clock-out",
    { config: write },
    async (request) => punch(request, "clock_out"),
  );
}
