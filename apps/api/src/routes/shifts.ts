import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  emitEvent,
  openShifts,
  rebuildShift,
  recordPunch,
  ShiftError,
  type Queryable,
  type ShiftRow,
} from "@west4/db";
import { DUTIES, businessDate, dutiesFor, type Duty, type PunchKind } from "@west4/rules";
import { Temporal, type Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { venueClock } from "../rooms/assignment.js";
import { myTips } from "../tips/mine.js";
import { clockOutChecklist } from "../timeclock/checklist.js";

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
): Promise<
  { membership_id: string; user_id: string; name: string; role: string; shift: ShiftView | null }[]
> {
  const people = await c.query<{
    membership_id: string;
    user_id: string;
    name: string;
    role: string;
  }>(
    `select m.id as membership_id, m.user_id, u.name, m.role from memberships m join users u on u.id = m.user_id
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

/** Cash tips as whole cents, $0.00 included: never a float (U-06). */
const cashTips = z.number().int().min(0).max(10_000_000);

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

  // My tips (M7-10): the caller's own 146-2.17 records, never anyone else's. Two weeks by default;
  // records go back 6 years, a year at most per request.
  app.get<{ Params: { venueId: string }; Querystring: { from?: string; to?: string } }>(
    "/v1/venues/:venueId/me/tips",
    { config: staff },
    async (request) => {
      const m = me(request);
      const p = request.principal as Extract<typeof request.principal, { kind: "user" }>;
      const DATE = /^\d{4}-\d{2}-\d{2}$/;
      for (const d of [request.query.from, request.query.to])
        if (d !== undefined && !DATE.test(d))
          throw new ApiError("invalid_request", "dates are YYYY-MM-DD");
      return request.inVenue(async (c) => {
        const venue = await venueClock(c, request.venueId!);
        const today = businessDate(
          options.clock.now(),
          venue.timeZone,
          venue.dayCutover,
        ).businessDate;
        const to = request.query.to ? Temporal.PlainDate.from(request.query.to) : today;
        const from = request.query.from
          ? Temporal.PlainDate.from(request.query.from)
          : to.subtract({ days: 13 });
        if (Temporal.PlainDate.compare(from, to) > 0 || from.until(to).days > 366)
          throw new ApiError("invalid_request", "ask for a year at most, from before to");
        return myTips(c, request.venueId!, {
          userId: p.userId,
          role: m.role,
          from: from.toString(),
          to: to.toString(),
          now: options.clock.now(),
        });
      });
    },
  );

  // Who's on the clock, and the signed-in person's own shift and duties.
  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/shifts",
    { config: staff },
    async (request) => {
      const m = me(request);
      return request.inVenue(async (c) => {
        const team = await teamOnTheClock(c, request.venueId!);
        const mine = team.find((t) => t.membership_id === m.membershipId);
        // The duty of their last shift, so Clock in comes with it picked (U-14).
        const last = (
          await c.query<{ duty: Duty }>(
            `select duty from shifts where venue_id = $1 and membership_id = $2
              order by started_at desc limit 1`,
            [request.venueId!, m.membershipId],
          )
        ).rows[0];
        return {
          server_time: options.clock.now().toString(),
          me: {
            membership_id: m.membershipId,
            duties: dutiesFor(m.role),
            shift: mine?.shift ?? null,
            last_duty:
              last && dutiesFor(m.role).includes(last.duty) ? last.duty : (null as Duty | null),
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

  // Clock out (M7-11), in one tap (U-14; D133): with { cash_tips_cents } the cash tips are
  // declared in the same transaction, then the checklist is checked, then the punch. Any other
  // line still open refuses with 409 checklist_open and rolls the declaration back with it, so
  // nothing is half done; without an amount, a shift still owing its declaration is refused.
  const clockOutBody = z.object({ cash_tips_cents: cashTips.optional() }).strict();
  app.post<{ Params: { venueId: string }; Body: unknown }>(
    "/v1/venues/:venueId/shifts/clock-out",
    { config: write },
    async (request) => {
      const parsed = clockOutBody.safeParse(request.body ?? {});
      if (!parsed.success)
        throw new ApiError("invalid_request", "send {} or { cash_tips_cents } in whole cents");
      const m = me(request);
      const p = request.principal as Extract<typeof request.principal, { kind: "user" }>;
      const venueId = request.venueId!;
      const tips = parsed.data.cash_tips_cents;
      return request.inVenue(async (c) => {
        if (tips !== undefined) await declareCashTips(c, venueId, m.membershipId, tips, true);
        const items = await clockOutChecklist(c, venueId, {
          userId: p.userId,
          membershipId: m.membershipId,
          role: m.role,
        });
        if (items.length > 0)
          throw new ApiError(
            "checklist_open",
            "there's still something to do before you clock out",
            { details: { items } },
          );
        const venue = await venueClock(c, venueId);
        const shift = await recordPunch(c, {
          venueId,
          membershipId: m.membershipId,
          kind: "clock_out",
          at: options.clock.now(),
          deviceId: deviceOf(request),
          venue,
        }).catch(refusal);
        return { shift: shiftView(shift), cash_tips_cents: tips ?? null };
      });
    },
  );

  // What's left before clock-out, each line with its fix (M7-11; screens N24).
  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/shifts/checklist",
    { config: staff },
    async (request) => {
      const m = me(request);
      const p = request.principal as Extract<typeof request.principal, { kind: "user" }>;
      return {
        items: await request.inVenue((c) =>
          clockOutChecklist(c, request.venueId!, {
            userId: p.userId,
            membershipId: m.membershipId,
            role: m.role,
          }),
        ),
      };
    },
  );

  // Declare cash tips at clock-out (M7-11): any amount, $0.00 included; over zero it's a cash_tip ledger row.
  const declareBody = z.object({ cash_tips_cents: cashTips }).strict();
  app.post<{ Params: { venueId: string }; Body: unknown }>(
    "/v1/venues/:venueId/shifts/declare-tips",
    { config: write },
    async (request) => {
      const parsed = declareBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { cash_tips_cents }");
      const m = me(request);
      const venueId = request.venueId!;
      return request.inVenue((c) =>
        declareCashTips(c, venueId, m.membershipId, parsed.data.cash_tips_cents, false),
      );
    },
  );

  /**
   * The declaration on the caller's open shift. Once made it stands: declaring again is refused,
   * except that clock-out (`again`) may carry the same amount, so its retry still goes through.
   */
  async function declareCashTips(
    c: Queryable,
    venueId: string,
    membershipId: string,
    cents: number,
    again: boolean,
  ) {
    const shift = (
      await c.query<{ id: string; business_date: string; declared: boolean; cents: number | null }>(
        `select id, business_date::text, cash_tips_declared_at is not null as declared,
                cash_tips_declared_cents::int as cents from shifts
          where venue_id = $1 and membership_id = $2 and ended_at is null for update`,
        [venueId, membershipId],
      )
    ).rows[0];
    if (!shift) throw new ApiError("invalid_request", "you're not on the clock");
    if (shift.declared) {
      if (again && shift.cents === cents) return { shift_id: shift.id, cash_tips_cents: cents };
      throw new ApiError("version_conflict", "your cash tips are already declared", {
        details: { cash_tips_cents: shift.cents },
      });
    }
    await c.query(
      "update shifts set cash_tips_declared_cents = $3, cash_tips_declared_at = $4 where venue_id = $1 and id = $2",
      [venueId, shift.id, cents, options.clock.now().toString()],
    );
    if (cents > 0)
      await c.query("select tip_ledger_write($1, 'cash_tip', $2, $3::date, null, null, null)", [
        venueId,
        cents,
        shift.business_date,
      ]);
    await emitEvent(c, { venueId, type: "shift.updated", entityId: shift.id });
    return { shift_id: shift.id, cash_tips_cents: cents };
  }

  // Tonight's punches, for Admin → Team's "Time clock · tonight" (owners and managers).
  const managers = route({ principals: ["owner_manager"], module: "team" });
  app.get<{ Params: { venueId: string }; Querystring: { date?: string } }>(
    "/v1/venues/:venueId/punches",
    { config: managers },
    async (request) => {
      const venueId = request.venueId!;
      return request.inVenue(async (c) => {
        const venue = await venueClock(c, venueId);
        const date =
          request.query.date && /^\d{4}-\d{2}-\d{2}$/.test(request.query.date)
            ? request.query.date
            : businessDate(
                options.clock.now(),
                venue.timeZone,
                venue.dayCutover,
              ).businessDate.toString();
        const r = await c.query<{
          id: string;
          name: string;
          user_id: string;
          kind: string;
          duty: string | null;
          at: string;
          reason: string | null;
        }>(
          `select p.id, u.name, m.user_id, p.kind, p.duty, to_json(p.at) #>> '{}' as at, p.reason
             from time_punches p join memberships m on m.venue_id = p.venue_id and m.id = p.membership_id
             join users u on u.id = m.user_id
             join shifts s on s.venue_id = p.venue_id and s.membership_id = p.membership_id
              and p.at >= s.started_at and (s.ended_at is null or p.at <= s.ended_at)
            where p.venue_id = $1 and s.business_date = $2::date
            order by p.at, p.id`,
          [venueId, date],
        );
        return { business_date: date, punches: r.rows };
      });
    },
  );

  // Edit a punch (M7-11): owners and managers, in a passkey session, with a reason, never their own;
  // the old time stays in the audit log and the shift is rebuilt.
  const editBody = z
    .object({
      at: z.string().datetime({ offset: true }),
      reason: z.string().trim().min(1).max(300),
    })
    .strict();
  app.patch<{ Params: { venueId: string; p: string }; Body: unknown }>(
    "/v1/venues/:venueId/punches/:p",
    { config: route({ principals: ["owner_manager"], module: "team", idempotency: "optional" }) },
    async (request) => {
      if (!z.string().uuid().safeParse(request.params.p).success)
        throw new ApiError("not_found", "no such punch");
      const parsed = editBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError("invalid_request", "send { at, reason }: an edit needs a reason", {
          details: { reason: "reason" },
        });
      const m = me(request);
      const p = request.principal as Extract<typeof request.principal, { kind: "user" }>;
      if (m.role !== "owner" && m.role !== "manager")
        throw new ApiError("forbidden", "owners and managers edit punches");
      if (request.session?.assurance !== "passkey")
        throw new ApiError("forbidden", "editing a punch needs your passkey session, not a PIN");
      const venueId = request.venueId!;
      return request.inVenue(async (c) => {
        const punchRow = (
          await c.query<{ membership_id: string; user_id: string; kind: string }>(
            `select p.membership_id, m.user_id, p.kind from time_punches p
               join memberships m on m.venue_id = p.venue_id and m.id = p.membership_id
              where p.venue_id = $1 and p.id = $2 for update of p`,
            [venueId, request.params.p],
          )
        ).rows[0];
        if (!punchRow) throw new ApiError("not_found", "no such punch");
        if (punchRow.user_id === p.userId)
          throw new ApiError("forbidden", "your own punches are edited by someone else");
        // The shift the punch belongs to: its own clock-in, or the latest clock-in before it.
        const clockIn = (
          await c.query<{ id: string }>(
            `select id from time_punches where venue_id = $1 and membership_id = $2 and kind = 'clock_in'
               and at <= (select at from time_punches where venue_id = $1 and id = $3)
             order by at desc limit 1`,
            [venueId, punchRow.membership_id, request.params.p],
          )
        ).rows[0];
        await c.query(
          "update time_punches set at = $3, edited_by = $4, reason = $5 where venue_id = $1 and id = $2",
          [venueId, request.params.p, parsed.data.at, p.userId, parsed.data.reason],
        );
        const venue = await venueClock(c, venueId);
        const shift = clockIn
          ? await rebuildShift(
              c,
              venueId,
              punchRow.kind === "clock_in" ? request.params.p : clockIn.id,
              venue,
            )
          : null;
        if (shift) await emitEvent(c, { venueId, type: "shift.updated", entityId: shift.id });
        return {
          punch_id: request.params.p,
          at: parsed.data.at,
          shift: shift ? shiftView(shift) : null,
        };
      });
    },
  );
}
