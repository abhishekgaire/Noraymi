import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { FastifyRequest } from "fastify";
import {
  approvalPeople,
  drawerLogOfDate,
  drawerOfDevice,
  drawerSessionById,
  drawerSessionMoves,
  drawerSessionsOfDate,
  emitEvent,
  insertApproval,
  openDrawerSession,
  pendingDrawerHandover,
  readSetting,
  recordDrawerCount,
  recordPunch,
  venueDrawers,
  withVenue,
  type DrawerPanelRow,
  type DrawerSessionRow,
  type Queryable,
  type Sweep,
} from "@west4/db";
import { businessDate, checkCount, drawerTotals } from "@west4/rules";
import { Temporal, type CashSettings } from "@west4/shared";
import { type Clock } from "@west4/shared";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { declineHandlers, executors, managerOnDutyAt } from "../approvals/service.js";
import { enqueuePush } from "../push/send-push.js";
import { venueClock } from "../rooms/assignment.js";

/**
 * Cash drawers (M4-13; Money rules 15; spec 08 · Drawer):
 *   GET  /v1/venues/{v}/drawers            each drawer, its printer and its open session
 *   POST /v1/venues/{v}/drawers/{d}/open   open the drawer's session by hand, with the starting bank
 *   POST /v1/venues/{v}/drawer-sessions/{s}/count   a blind count (M7-05)
 *   POST /v1/venues/{v}/drawers/{d}/handover        count a house drawer blind and hand it to the incoming manager
 * The `drawers.open` sweep opens every drawer's session as the business date
 * starts, with `drawer.startingBankCents` and the model from the `drawer`
 * setting, so cash always has somewhere to go.
 *
 * Counts are blind (M7-05; Money rules 15): the request carries only the
 * counted cents, and only the answer shows what the drawer should hold and
 * the over or short. Once counted, the number stands: a count that needs a
 * note or a second counter is kept on the session, and the retry must carry
 * the same number, so seeing the answer can't change the count.
 */
async function openFor(
  c: Queryable,
  venueId: string,
  drawerId: string,
  now: Temporal.Instant,
  perPerson?: { ownerId: string; countedCents: number },
): Promise<{ id: string | null; opened: boolean; model: "house" | "per_person" }> {
  const v = (
    await c.query<{ time_zone: string; day_cutover: string }>(
      "select time_zone, to_char(day_cutover, 'HH24:MI') as day_cutover from venues where id = $1",
      [venueId],
    )
  ).rows[0]!;
  const date = businessDate(now, v.time_zone, v.day_cutover).businessDate;
  const setting = await readSetting(c, venueId, "drawer", date);
  const model = setting?.value.drawer === "perPerson" ? "per_person" : "house";
  // A drawer per person (M7-07) opens only when its owner counts in the starting bank.
  if (model === "per_person" && !perPerson) return { id: null, opened: false, model };
  const opened = await openDrawerSession(c, venueId, {
    drawerId,
    model,
    responsibleId: model === "house" ? await managerOnDutyAt(c, venueId, now) : null,
    ownerId: perPerson?.ownerId ?? null,
    businessDate: date.toString(),
    openingCents: perPerson ? perPerson.countedCents : (setting?.value.startingBankCents ?? 0),
    at: now.toString(),
  });
  return { ...opened, model };
}

/** The drawer model and its per-person options in force for the business date now (M7-07). */
async function modelNow(c: Queryable, venueId: string, now: Temporal.Instant) {
  const v = await venueClock(c, venueId);
  const date = businessDate(now, v.timeZone, v.dayCutover).businessDate;
  const value = (await readSetting(c, venueId, "drawer", date))?.value as CashSettings | undefined;
  return {
    model: value?.drawer === "perPerson" ? ("per_person" as const) : ("house" as const),
    who: value?.perPerson.who ?? "bartenders",
    countLater: value?.perPerson.countLater ?? false,
  };
}

/**
 * Who has a drawer of their own under `perPerson.who`: bartenders, and the
 * front desk, who covers the bar on a bartender's break (glossary · Front
 * desk); servers too with "bartendersAndServers".
 */
export function hasOwnDrawer(role: Role, who: "bartenders" | "bartendersAndServers"): boolean {
  return (
    role === "bartender" ||
    role === "front_desk" ||
    (who === "bartendersAndServers" && role === "staff")
  );
}

/** A per-person session is counted by its owner, or an owner or manager; a house one by D21. */
function mayCountSession(
  actor: { userId: string; role: Role },
  session: DrawerSessionRow,
): boolean {
  if (session.model === "per_person")
    return session.owner_id === actor.userId || actor.role === "owner" || actor.role === "manager";
  return mayCount(actor.role, session.station);
}

type Role = "owner" | "manager" | "bartender" | "front_desk" | "staff";

/** Owners and managers count either drawer, bartenders the bar drawer, the front desk its own (D21). */
export function mayCount(role: Role, station: "bar" | "front_desk" | null): boolean {
  if (role === "owner" || role === "manager") return true;
  if (role === "bartender") return station === "bar";
  if (role === "front_desk") return station === "front_desk";
  return false;
}

const countBody = z
  .object({
    counted_cents: z.number().int().min(0).max(100_000_000),
    note: z.string().trim().max(500).optional(),
    pin: z
      .string()
      .regex(/^\d{4,6}$/)
      .optional(),
    witness: z
      .object({ user_id: z.string().uuid(), pin: z.string().regex(/^\d{4,6}$/) })
      .optional(),
  })
  .strict();
type CountBody = z.infer<typeof countBody>;
const openBody = z
  .object({
    counted_cents: z.number().int().min(0).max(100_000_000).optional(),
    pin: z
      .string()
      .regex(/^\d{4,6}$/)
      .optional(),
  })
  .strict();

interface Actor {
  readonly userId: string;
  readonly role: Role;
  readonly deviceId: string | null;
}

function actorOf(request: FastifyRequest): Actor {
  const p = request.principal;
  if (p.kind !== "user")
    throw new ApiError("forbidden", "counting a drawer needs a person signed in");
  const m = p.memberships.find((x) => x.venueId === request.venueId);
  if (!m) throw new ApiError("forbidden", "not a member of this venue");
  return {
    userId: p.userId,
    role: m.role,
    deviceId: request.signedDevice?.deviceId ?? request.session?.deviceId ?? null,
  };
}

/**
 * The PIN again for a count (spec 02 · Badges: cash counts ask for the PIN
 * again), for a PIN or badge session; and the second counter's own PIN.
 * Both before the transaction, since each records its own failures.
 */
async function checkPins(request: FastifyRequest, body: CountBody): Promise<void> {
  const p = request.principal;
  if (p.kind === "user" && (p.session === "pin" || p.session === "badge")) {
    if (!body.pin)
      throw new ApiError("invalid_request", "counting asks for your PIN again", {
        details: { reason: "pin" },
      });
    await request.server.checkPinAgain(request, body.pin);
  }
  if (body.witness) {
    if (p.kind === "user" && body.witness.user_id === p.userId)
      throw new ApiError("invalid_request", "the second counter is someone else");
    await request.server.checkPinOf(
      request,
      request.venueId!,
      body.witness.user_id,
      body.witness.pin,
    );
  }
}

/** The blind count's answer: only now what the drawer should have held. */
export interface CountAnswer {
  readonly session_id: string;
  readonly drawer: string;
  readonly opened_with_cents: number;
  readonly cash_taken_cents: number;
  readonly drops_cents: number;
  readonly refunds_cents: number;
  readonly paid_outs_cents: number;
  readonly tip_outs_cents: number;
  readonly expected_cents: number;
  readonly counted_cents: number;
  readonly over_short_cents: number;
  readonly note: string | null;
  readonly witness_id: string | null;
}

type CountOutcome =
  | { readonly ok: true; readonly answer: CountAnswer }
  | {
      readonly ok: false;
      readonly reason: "note" | "witness";
      readonly answer: CountAnswer;
    };

/**
 * Counts a session inside the venue transaction. A count that still needs a
 * note or a second counter is kept on the open session (counted_cents and who
 * counted it) and refused, so the retry carries the same number.
 */
async function countSession(
  c: Queryable,
  venueId: string,
  session: DrawerSessionRow,
  input: { body: CountBody; actor: Actor; at: Temporal.Instant; close: boolean },
): Promise<CountOutcome> {
  if (session.state !== "open" && session.state !== "pulled")
    throw new ApiError("version_conflict", `this drawer is already ${session.state}`);
  const kept = (
    await c.query<{ counted_cents: string | null }>(
      "select counted_cents::text from drawer_sessions where venue_id = $1 and id = $2",
      [venueId, session.id],
    )
  ).rows[0]?.counted_cents;
  if (kept !== null && kept !== undefined && Number(kept) !== input.body.counted_cents)
    throw new ApiError("version_conflict", "this drawer's count is already in", {
      details: { counted_cents: Number(kept) },
    });
  const setting = (
    await readSetting(c, venueId, "drawer", Temporal.PlainDate.from(session.business_date))
  )?.value as CashSettings | undefined;
  const totals = drawerTotals(
    session.opening_cents,
    await drawerSessionMoves(c, venueId, session.id),
  );
  const check = checkCount({
    countedCents: input.body.counted_cents,
    expectedCents: totals.expectedCents,
    noteOverCents: setting?.noteOverCents ?? 0,
    secondCounter: setting?.secondCounter ?? "whenOff",
  });
  const note = input.body.note?.trim() || null;
  const witnessId = input.body.witness?.user_id ?? null;
  const answer: CountAnswer = {
    session_id: session.id,
    drawer: session.drawer_name,
    opened_with_cents: totals.openingCents,
    cash_taken_cents: totals.cashTakenCents,
    drops_cents: totals.dropsCents,
    refunds_cents: totals.refundsCents,
    paid_outs_cents: totals.paidOutsCents,
    tip_outs_cents: totals.tipOutsCents,
    expected_cents: totals.expectedCents,
    counted_cents: input.body.counted_cents,
    over_short_cents: check.overShortCents,
    note,
    witness_id: witnessId,
  };
  const missing =
    check.needsNote && !note ? "note" : check.needsWitness && !witnessId ? "witness" : null;
  if (missing) {
    await c.query(
      `update drawer_sessions set counted_cents = $3, counted_by = $4, counted_at = $5
        where venue_id = $1 and id = $2 and counted_cents is null`,
      [venueId, session.id, input.body.counted_cents, input.actor.userId, input.at.toString()],
    );
    return { ok: false, reason: missing, answer };
  }
  if (witnessId) {
    const w = await c.query<{ role: Role }>(
      "select role from memberships where venue_id = $1 and user_id = $2 and status = 'active'",
      [venueId, witnessId],
    );
    if (!w.rows[0] || !mayCount(w.rows[0].role, session.station))
      throw new ApiError(
        "forbidden",
        "the second counter must be someone who may count this drawer",
      );
  }
  await recordDrawerCount(c, venueId, session.id, {
    countedCents: input.body.counted_cents,
    expectedCents: totals.expectedCents,
    overShortCents: check.overShortCents,
    note,
    countedBy: input.actor.userId,
    witnessId,
    at: input.at.toString(),
    close: input.close,
  });
  await emitEvent(c, { venueId, type: "drawer.updated", entityId: session.drawer_id });
  return { ok: true, answer };
}

function refuse(outcome: Extract<CountOutcome, { ok: false }>): never {
  throw new ApiError(
    "invalid_request",
    outcome.reason === "note"
      ? "a count this far off needs a note"
      : "a count this far off needs a second person to count",
    { details: { reason: outcome.reason, answer: outcome.answer } },
  );
}

/** Night's drawer panel: both drawers, blind until counted. */
function panelSession(s: DrawerPanelRow, waitingFor: string | null) {
  const counted = s.state === "counted" || s.state === "closed";
  return {
    id: s.id,
    state: s.state,
    model: s.model,
    owner: s.owner_name,
    tray_label: s.tray_label,
    opened_at: s.opened_at,
    opened_with_cents: s.opening_cents,
    responsible: s.responsible_name,
    accepted: s.handover_id === null || s.approved_by !== null,
    waiting_for: s.handover_id !== null && s.approved_by === null ? waitingFor : null,
    count: counted
      ? {
          counted_cents: s.counted_cents,
          expected_cents: s.expected_cents,
          over_short_cents: s.over_short_cents,
          note: s.note,
          counted_by: s.counted_by_name,
          witness: s.witness_name,
          counted_at: s.counted_at,
        }
      : null,
  };
}

export function drawerRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/drawers",
    { config: route({ principals: ["owner_manager", "staff", "shared_device"], module: "core" }) },
    async (request) => {
      const venueId = request.venueId!;
      const p = request.principal;
      const role =
        p.kind === "user" ? p.memberships.find((m) => m.venueId === venueId)?.role : undefined;
      return request.inVenue(async (c) => {
        const venue = await venueClock(c, venueId);
        const date = businessDate(
          options.clock.now(),
          venue.timeZone,
          venue.dayCutover,
        ).businessDate.toString();
        const sessions = await drawerSessionsOfDate(c, venueId, date);
        const handover = await pendingDrawerHandover(c, venueId);
        // Cash, per person, for the panel's breakdown after a count, read from the stored count and moves.
        const breakdown = new Map<string, ReturnType<typeof drawerTotals>>();
        for (const s of sessions)
          if (s.state === "counted" || s.state === "closed")
            breakdown.set(
              s.id,
              drawerTotals(s.opening_cents, await drawerSessionMoves(c, venueId, s.id)),
            );
        const people = (await approvalPeople(c, venueId)).filter((x) => x.role !== "staff");
        // Night's drawer log (M7-06): every move but sales, so the panel stays blind.
        const log = await drawerLogOfDate(c, venueId, date);
        // The drawer this screen is paired to, and the caller's staff bank, for Drop and the move buttons.
        const deviceId = request.signedDevice?.deviceId ?? request.session?.deviceId ?? null;
        const hereId = deviceId ? ((await drawerOfDevice(c, venueId, deviceId))?.id ?? null) : null;
        const bank =
          p.kind === "user"
            ? await c.query<{ cash_cents: number }>(
                "select cash_cents::int as cash_cents from staff_banks where venue_id = $1 and user_id = $2 and business_date = $3::date",
                [venueId, p.userId, date],
              )
            : null;
        const perPerson = await modelNow(c, venueId, options.clock.now());
        return {
          business_date: date,
          // The model in force tonight (M7-07), and whether this person counts in a drawer of their own.
          model: perPerson.model,
          count_later: perPerson.countLater,
          can_count_in:
            perPerson.model === "per_person" &&
            role !== undefined &&
            hasOwnDrawer(role, perPerson.who),
          // Who may count or take the drawers, for the second-counter and incoming-manager pickers.
          people: people.map((x) => ({ user_id: x.id, name: x.name, role: x.role })),
          me: {
            user_id: p.kind === "user" ? p.userId : null,
            // A PIN or badge session gives the PIN again to count (spec 02 · Badges).
            pin_again: p.kind === "user" && (p.session === "pin" || p.session === "badge"),
            bank_cents: bank?.rows[0]?.cash_cents ?? 0,
            role: role ?? null,
          },
          handover: handover
            ? {
                id: handover.id,
                waiting_for: { user_id: handover.to_user_id, name: handover.to_name },
              }
            : null,
          drawers: (await venueDrawers(c, venueId)).map((d) => ({
            id: d.id,
            name: d.name,
            station: d.station,
            printer: d.printer_name,
            open: d.session_id !== null,
            opening_cents: d.opening_cents,
            can_count:
              role !== undefined &&
              (() => {
                const open = sessions.find((s) => s.drawer_id === d.id && s.state === "open");
                if (open?.model === "per_person")
                  return (
                    open.owner_id === (p.kind === "user" ? p.userId : null) ||
                    role === "owner" ||
                    role === "manager"
                  );
                return mayCount(role, d.station as "bar" | "front_desk" | null);
              })(),
            here: d.id === hereId,
            sessions: sessions
              .filter((s) => s.drawer_id === d.id)
              .map((s) => {
                const view = {
                  ...panelSession(s, handover?.to_name ?? null),
                  moves: log
                    .filter((m) => m.drawer_session_id === s.id)
                    .map((m) => ({
                      id: m.id,
                      kind: m.kind,
                      amount_cents: m.amount_cents,
                      by: m.taken_by_name,
                      paid_to: m.paid_to_name,
                      reason: m.reason,
                      at: m.at,
                    })),
                };
                const t = breakdown.get(s.id);
                return t
                  ? {
                      ...view,
                      cash_taken_cents: t.cashTakenCents,
                      drops_cents: t.dropsCents,
                      refunds_cents: t.refundsCents,
                      paid_outs_cents: t.paidOutsCents,
                      tip_outs_cents: t.tipOutsCents,
                    }
                  : view;
              }),
          })),
        };
      });
    },
  );

  app.post<{ Params: { venueId: string; d: string } }>(
    "/v1/venues/:venueId/drawers/:d/open",
    {
      config: route({
        principals: ["owner_manager", "staff", "shared_device"],
        module: "core",
        idempotency: "optional",
      }),
    },
    async (request) => {
      if (!z.string().uuid().safeParse(request.params.d).success)
        throw new ApiError("not_found", "no such drawer");
      const parsed = openBody.safeParse(request.body ?? {});
      if (!parsed.success) throw new ApiError("invalid_request", "send { counted_cents }");
      const venueId = request.venueId!;
      const now = options.clock.now();
      const p = request.principal;
      const role =
        p.kind === "user" ? p.memberships.find((m) => m.venueId === venueId)?.role : undefined;
      const { model, who } = await request.inVenue(async (c) => {
        const found = await c.query("select 1 from cash_drawers where venue_id = $1 and id = $2", [
          venueId,
          request.params.d,
        ]);
        if (found.rowCount === 0) throw new ApiError("not_found", "no such drawer");
        return modelNow(c, venueId, now);
      });
      let perPerson: { ownerId: string; countedCents: number } | undefined;
      if (model === "per_person") {
        // Each person opens their own session by counting in the starting bank (Money rules 15).
        if (p.kind !== "user" || !role || !hasOwnDrawer(role, who))
          throw new ApiError("forbidden", "only someone with a drawer of their own counts one in", {
            details: { reason: "no_drawer" },
          });
        if (parsed.data.counted_cents === undefined)
          throw new ApiError("invalid_request", "count in the starting bank", {
            details: { reason: "count_in" },
          });
        await checkPins(request, {
          counted_cents: parsed.data.counted_cents,
          pin: parsed.data.pin,
        });
        perPerson = { ownerId: p.userId, countedCents: parsed.data.counted_cents };
      } else if (role === "staff")
        throw new ApiError("forbidden", "this drawer is opened by the people who work it");
      return request.inVenue(async (c) => {
        const s = await openFor(c, venueId, request.params.d, now, perPerson);
        if (!s.opened && s.model === "per_person" && s.id)
          throw new ApiError(
            "version_conflict",
            "this drawer is in use: swap or pull the tray first",
          );
        if (s.opened)
          await emitEvent(c, { venueId, type: "drawer.updated", entityId: request.params.d });
        return { session_id: s.id, opened: s.opened, model: s.model };
      });
    },
  );

  app.post<{ Params: { venueId: string; s: string }; Body: unknown }>(
    "/v1/venues/:venueId/drawer-sessions/:s/count",
    {
      config: route({
        principals: ["owner_manager", "staff"],
        module: "core",
        action: "drawer.count",
        idempotency: "optional",
      }),
    },
    async (request) => {
      if (!z.string().uuid().safeParse(request.params.s).success)
        throw new ApiError("not_found", "no such drawer session");
      const parsed = countBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { counted_cents }");
      const actor = actorOf(request);
      const venueId = request.venueId!;
      const session = await request.inVenue((c) => drawerSessionById(c, venueId, request.params.s));
      if (!session) throw new ApiError("not_found", "no such drawer session");
      if (!mayCountSession(actor, session))
        throw new ApiError("forbidden", "this drawer is counted by the people who work it");
      await checkPins(request, parsed.data);
      const outcome = await request.inVenue(async (c) => {
        const locked = await drawerSessionById(c, venueId, request.params.s, true);
        return countSession(c, venueId, locked!, {
          body: parsed.data,
          actor,
          at: options.clock.now(),
          close: false,
        });
      });
      if (!outcome.ok) refuse(outcome);
      return outcome.answer;
    },
  );

  const handoverBody = countBody.extend({ incoming: z.string().uuid() }).strict();
  app.post<{ Params: { venueId: string; d: string }; Body: unknown }>(
    "/v1/venues/:venueId/drawers/:d/handover",
    {
      config: route({
        principals: ["owner_manager"],
        module: "core",
        action: "drawer.count",
        idempotency: "optional",
      }),
    },
    async (request) => {
      if (!z.string().uuid().safeParse(request.params.d).success)
        throw new ApiError("not_found", "no such drawer");
      const parsed = handoverBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError("invalid_request", "send { incoming, counted_cents }");
      const { incoming, ...count } = parsed.data;
      const actor = actorOf(request);
      if (actor.role !== "owner" && actor.role !== "manager")
        throw new ApiError("forbidden", "the manager on duty hands the drawers over");
      if (incoming === actor.userId)
        throw new ApiError("invalid_request", "hand the drawers to someone else");
      const venueId = request.venueId!;
      const open = await request.inVenue(async (c) => {
        const r = await c.query<{ id: string }>(
          "select id from drawer_sessions where venue_id = $1 and drawer_id = $2 and state = 'open'",
          [venueId, request.params.d],
        );
        return r.rows[0]?.id ?? null;
      });
      if (!open) throw new ApiError("not_found", "this drawer has no open session");
      await checkPins(request, count);
      const now = options.clock.now();
      const result = await request.inVenue(async (c) => {
        const session = (await drawerSessionById(c, venueId, open, true))!;
        if (session.model !== "house")
          throw new ApiError("invalid_request", "a handover is for a house drawer");
        const people = await approvalPeople(c, venueId);
        const to = people.find((x) => x.id === incoming);
        if (!to || (to.role !== "owner" && to.role !== "manager"))
          throw new ApiError("invalid_request", "hand the drawers to an owner or a manager");
        let handover = await pendingDrawerHandover(c, venueId);
        if (handover && handover.to_user_id !== incoming)
          throw new ApiError("version_conflict", `a handover to ${handover.to_name} is waiting`);
        const outcome = await countSession(c, venueId, session, {
          body: count,
          actor,
          at: now,
          close: true,
        });
        if (!outcome.ok) return outcome;
        if (!handover) {
          const id = (
            await c.query<{ id: string }>(
              `insert into drawer_handovers (venue_id, business_date, from_user_id, to_user_id, requested_at, requested_device_id)
               values ($1, $2, $3, $4, $5, $6) returning id`,
              [
                venueId,
                session.business_date,
                actor.userId,
                incoming,
                now.toString(),
                actor.deviceId,
              ],
            )
          ).rows[0]!.id;
          const approvalId = await insertApproval(c, venueId, {
            kind: "drawer_handover",
            targetKind: "drawer_handover",
            targetId: id,
            amountCents: null,
            reason: "drawer handover",
            payload: {},
            requestedBy: actor.userId,
            requestedDeviceId: actor.deviceId,
            requestedAt: now.toString(),
            routedTo: incoming,
          });
          await c.query(
            "update drawer_handovers set approval_id = $3 where venue_id = $1 and id = $2",
            [venueId, id, approvalId],
          );
          for (const userId of [incoming, actor.userId])
            await emitEvent(c, {
              venueId,
              type: "approval.requested",
              entityId: approvalId,
              audience: "user",
              userId,
            });
          await enqueuePush(c, {
            venueId,
            audience: { kind: "person", userId: incoming },
            message: {
              key: "approvals.push",
              params: { name: people.find((x) => x.id === actor.userId)?.name ?? "" },
              url: "/approvals",
              tag: `approval-${approvalId}`,
            },
            runAt: now,
          });
          handover = {
            id,
            from_user_id: actor.userId,
            to_user_id: incoming,
            to_name: to.name,
            approval_id: approvalId,
            state: "pending",
          };
        }
        // The next session opens with the counted cash, answered for by the incoming manager.
        const next = (
          await c.query<{ id: string }>(
            `insert into drawer_sessions (venue_id, drawer_id, model, responsible_id, state, business_date, opened_at,
               opening_cents, handover_id)
             values ($1, $2, 'house', $3, 'open', $4::date, $5, $6, $7) returning id`,
            [
              venueId,
              session.drawer_id,
              incoming,
              session.business_date,
              now.toString(),
              count.counted_cents,
              handover.id,
            ],
          )
        ).rows[0]!.id;
        return { ...outcome, next, handover };
      });
      if (!result.ok) refuse(result);
      const done = result as Extract<CountOutcome, { ok: true }> & {
        next: string;
        handover: { id: string; approval_id: string | null; to_user_id: string; to_name: string };
      };
      return {
        ...done.answer,
        next_session_id: done.next,
        handover: {
          id: done.handover.id,
          approval_id: done.handover.approval_id,
          waiting_for: { user_id: done.handover.to_user_id, name: done.handover.to_name },
        },
      };
    },
  );

  /** The open per-person session on a drawer, for its owner or a manager (M7-07). */
  const ownSession = async (request: FastifyRequest<{ Params: { d: string } }>, actor: Actor) => {
    if (!z.string().uuid().safeParse(request.params.d).success)
      throw new ApiError("not_found", "no such drawer");
    const venueId = request.venueId!;
    const session = await request.inVenue(async (c) => {
      const r = await c.query<{ id: string }>(
        "select id from drawer_sessions where venue_id = $1 and drawer_id = $2 and state = 'open'",
        [venueId, request.params.d],
      );
      return r.rows[0] ? drawerSessionById(c, venueId, r.rows[0].id) : null;
    });
    if (!session) throw new ApiError("not_found", "this drawer has no open session");
    if (session.model !== "per_person")
      throw new ApiError(
        "invalid_request",
        "swap and pull are for a drawer per person; hand a house drawer over",
      );
    if (!mayCountSession(actor, session))
      throw new ApiError("forbidden", "only the drawer's owner or a manager swaps or pulls it");
    return session;
  };

  // A shift change, counted now: the owner's session is counted blind and the drawer is free.
  app.post<{ Params: { venueId: string; d: string }; Body: unknown }>(
    "/v1/venues/:venueId/drawers/:d/swap",
    {
      config: route({
        principals: ["owner_manager", "staff"],
        module: "core",
        idempotency: "optional",
      }),
    },
    async (request) => {
      const parsed = countBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { counted_cents }");
      const actor = actorOf(request);
      const session = await ownSession(request, actor);
      await checkPins(request, parsed.data);
      const venueId = request.venueId!;
      const outcome = await request.inVenue(async (c) =>
        countSession(c, venueId, (await drawerSessionById(c, venueId, session.id, true))!, {
          body: parsed.data,
          actor,
          at: options.clock.now(),
          close: false,
        }),
      );
      if (!outcome.ok) refuse(outcome);
      return outcome.answer;
    },
  );

  // A shift change, counted later (`perPerson.countLater`): the tray comes out, labelled, for the close.
  const pullBody = z.object({ tray_label: z.string().trim().min(1).max(60).optional() }).strict();
  app.post<{ Params: { venueId: string; d: string }; Body: unknown }>(
    "/v1/venues/:venueId/drawers/:d/pull",
    {
      config: route({
        principals: ["owner_manager", "staff"],
        module: "core",
        idempotency: "optional",
      }),
    },
    async (request) => {
      const parsed = pullBody.safeParse(request.body ?? {});
      if (!parsed.success) throw new ApiError("invalid_request", "send { tray_label? }");
      const actor = actorOf(request);
      const session = await ownSession(request, actor);
      const venueId = request.venueId!;
      const now = options.clock.now();
      return request.inVenue(async (c) => {
        if (!(await modelNow(c, venueId, now)).countLater)
          throw new ApiError("invalid_request", "this venue counts a drawer at the shift change", {
            details: { reason: "count_now" },
          });
        const owner = (
          await c.query<{ name: string }>("select name from users where id = $1", [
            session.owner_id,
          ])
        ).rows[0]?.name;
        const label =
          parsed.data.tray_label ??
          `${session.drawer_name.replace(/ drawer$/i, "")} · ${owner ?? ""}`;
        await c.query(
          `update drawer_sessions set state = 'pulled', pulled_at = $3, tray_label = $4
            where venue_id = $1 and id = $2 and state = 'open'`,
          [venueId, session.id, now.toString(), label],
        );
        await emitEvent(c, { venueId, type: "drawer.updated", entityId: session.drawer_id });
        return { session_id: session.id, state: "pulled", tray_label: label };
      });
    },
  );
}

/**
 * Accepting a handover, on the incoming manager's own phone (the approvals
 * route checks it's theirs and not the requester's device): the new sessions
 * are theirs, and they become the manager on duty. Someone not on the clock
 * is clocked in with the Manager duty; someone on another duty is refused.
 */
executors.set("drawer_handover", async (c, venueId, approval, ctx) => {
  const h = await c.query<{ state: string; to_user_id: string }>(
    "select state, to_user_id from drawer_handovers where venue_id = $1 and id = $2 for update",
    [venueId, approval.target_id],
  );
  if (h.rows[0]?.state !== "pending") return;
  const m = (
    await c.query<{ id: string }>(
      "select id from memberships where venue_id = $1 and user_id = $2 and status = 'active'",
      [venueId, ctx.approverId],
    )
  ).rows[0];
  if (!m) throw new ApiError("forbidden", "not a member of this venue");
  const open = (
    await c.query<{ id: string; duty: string }>(
      "select id, duty from shifts where venue_id = $1 and membership_id = $2 and ended_at is null",
      [venueId, m.id],
    )
  ).rows[0];
  if (open && open.duty !== "manager")
    throw new ApiError(
      "invalid_request",
      "clock out of your other duty to take the drawers as manager",
    );
  const shiftId = open
    ? open.id
    : (
        await recordPunch(c, {
          venueId,
          membershipId: m.id,
          kind: "clock_in",
          duty: "manager",
          at: ctx.at,
          deviceId: null,
          venue: await venueClock(c, venueId),
        })
      ).id;
  await c.query("update shifts set on_duty_since = $3 where venue_id = $1 and id = $2", [
    venueId,
    shiftId,
    ctx.at.toString(),
  ]);
  await c.query(
    "update drawer_handovers set state = 'accepted', decided_at = $3 where venue_id = $1 and id = $2",
    [venueId, approval.target_id, ctx.at.toString()],
  );
  const drawers = await c.query<{ drawer_id: string }>(
    "update drawer_sessions set approved_by = $3 where venue_id = $1 and handover_id = $2 returning drawer_id",
    [venueId, approval.target_id, ctx.approverId],
  );
  for (const d of drawers.rows)
    await emitEvent(c, { venueId, type: "drawer.updated", entityId: d.drawer_id });
  await emitEvent(c, { venueId, type: "shift.updated", entityId: shiftId });
});

/** Declined: the drawers stay with the manager who handed them over. */
declineHandlers.set("drawer_handover", async (c, venueId, approval, ctx) => {
  const h = await c.query<{ from_user_id: string }>(
    `update drawer_handovers set state = 'declined', decided_at = $3 where venue_id = $1 and id = $2 and state = 'pending'
     returning from_user_id`,
    [venueId, approval.target_id, ctx.at.toString()],
  );
  if (!h.rows[0]) return;
  const drawers = await c.query<{ drawer_id: string }>(
    "update drawer_sessions set responsible_id = $3 where venue_id = $1 and handover_id = $2 returning drawer_id",
    [venueId, approval.target_id, h.rows[0].from_user_id],
  );
  for (const d of drawers.rows)
    await emitEvent(c, { venueId, type: "drawer.updated", entityId: d.drawer_id });
});

/** The drawer was counted for tonight already: the sweep doesn't open a fresh bank on the same business date. */
async function countedOn(c: Queryable, venueId: string, drawerId: string, now: Temporal.Instant) {
  const v = await venueClock(c, venueId);
  const date = businessDate(now, v.timeZone, v.dayCutover).businessDate.toString();
  const r = await c.query(
    "select 1 from drawer_sessions where venue_id = $1 and drawer_id = $2 and business_date = $3::date",
    [venueId, drawerId, date],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Opens every drawer's session for the business date that has started, if it isn't open yet. */
export async function sweepDrawers(pool: pg.Pool, now: Temporal.Instant): Promise<number> {
  const venues = await pool.query<{ id: string }>("select id from venues_for_scheduler()");
  let opened = 0;
  for (const v of venues.rows)
    opened += await withVenue(pool, { venueId: v.id, requestId: "drawers-open" }, async (c) => {
      let n = 0;
      for (const d of await venueDrawers(c, v.id))
        if (
          !d.session_id &&
          !(await countedOn(c, v.id, d.id, now)) &&
          (await openFor(c, v.id, d.id, now)).opened
        )
          n += 1;
      return n;
    });
  return opened;
}

export function drawerSweep(pool: pg.Pool): Sweep {
  return {
    name: "drawers.open",
    everyMs: 5 * 60_000,
    run: async (now) => void (await sweepDrawers(pool, now)),
  };
}
