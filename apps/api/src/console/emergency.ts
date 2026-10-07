import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import {
  consoleVenue,
  decideEmergencyAction,
  emergencyAction,
  emergencyActions,
  emergencyState,
  finishEmergencyAction,
  readerOfVenue,
  reprintJob,
  requestEmergencyAction,
  stripeAccountFor,
  withdrawEmergencyAction,
  withVenue,
  type EmergencyActionRow,
  type Queryable,
  type RequestContext,
} from "@west4/db";
import {
  EMERGENCY_APPROVAL_MINUTES,
  isEmergencyAction,
  NIGHT_FIXES,
  type Clock,
} from "@west4/shared";
import { isAllowed } from "../email/policy.js";
import type { EmailSettings } from "../email/settings.js";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { enqueueEmail } from "../jobs/send-email.js";
import { applyNightFixes, closeNight, type NightFixInput } from "../nights/close.js";
import { checkNow } from "../payments/run.js";
import { enqueuePush } from "../push/send-push.js";
import { StripeError, StripeUnknownResult, type StripeClient } from "../stripe/client.js";
import { cancelReaderAction } from "../stripe/payments.js";

/**
 * The Console's emergency path (M8-11; spec 02 · Support access; spec 13 · On
 * call; spec 12 · 7; screens N39, Console). Four actions and nothing else:
 * re-sync a payment (the payment state machine run against Stripe for one
 * payment), cancel a reader action (cancel_action on one reader), requeue a
 * print (a reprint of one job) and close a stuck night (the normal close, after
 * only the named stale-item fixes). One of our staff asks with a reason; the
 * venue's owner is told at once, by push and email; a second person on our
 * side approves it in their own Console session before its time box ends, and
 * only then does it run. Nobody approves their own. Every audit row the action
 * writes names who asked (actor), who approved (approver) and the request.
 */
export interface EmergencyOut extends EmergencyActionRow {
  readonly state: ReturnType<typeof emergencyState>;
}

export const emergencyOut = (e: EmergencyActionRow, atMs: number): EmergencyOut => ({
  ...e,
  state: emergencyState(e, atMs),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Stage = "opened" | "done" | "failed";

/** Tells the venue's owners: a push and an email each, in their language. */
async function tellOwners(
  c: Queryable,
  email: Pick<EmailSettings, "allowList">,
  e: EmergencyActionRow,
  stage: Stage,
  runAt: Parameters<typeof enqueuePush>[1]["runAt"],
): Promise<void> {
  const venueName =
    (await c.query<{ name: string }>("select name from venues where id = $1", [e.venue_id])).rows[0]
      ?.name ?? "";
  const owners = (
    await c.query<{ user_id: string; email: string | null; locale: "en" | "es" }>(
      `select m.user_id, u.email, m.locale from memberships m join users u on u.id = m.user_id
        where m.venue_id = $1 and m.role = 'owner' and m.status = 'active' order by u.name`,
      [e.venue_id],
    )
  ).rows;
  const name = e.requested_by_name ?? "";
  const approver = e.decided_by_name ?? "";
  for (const to of owners) {
    const key = `emergency:${e.id}:${stage}:${to.user_id}`;
    await enqueuePush(c, {
      venueId: e.venue_id,
      audience: { kind: "person", userId: to.user_id },
      message: {
        key: `emergency.push.${stage}`,
        params: { name, approver, reason: e.reason.slice(0, 120) },
        url: "/admin/console",
        tag: `emergency-${e.id}`,
      },
      runAt,
      dedupeKey: `${key}:push`,
    });
    // On staging an address outside the allow-list is skipped; the push still goes.
    if (to.email && isAllowed(email.allowList, to.email))
      await enqueueEmail(c, email, {
        venueId: e.venue_id,
        to: to.email,
        locale: to.locale,
        template: "emergency_action",
        data: {
          venueName,
          stage,
          action: e.action as "requeue_print",
          requestedBy: name,
          approvedBy: approver,
          reason: e.reason,
        },
        runAt,
        dedupeKey: `${key}:email`,
      });
  }
}

function parseFixes(raw: unknown): NightFixInput[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 50)
    throw new ApiError("invalid_request", "fixes is a list of up to 50");
  return raw.map((f: unknown) => {
    const x = (f ?? {}) as { kind?: unknown; id?: unknown; reason?: unknown };
    const reason = typeof x.reason === "string" ? x.reason.trim() : "";
    if (
      !(NIGHT_FIXES as readonly unknown[]).includes(x.kind) ||
      typeof x.id !== "string" ||
      !UUID.test(x.id) ||
      reason.length < 3 ||
      reason.length > 500
    )
      throw new ApiError(
        "invalid_request",
        `each fix is { kind: ${NIGHT_FIXES.join(" | ")}, id, reason }`,
      );
    return { kind: x.kind as NightFixInput["kind"], id: x.id, reason };
  });
}

/** The target must be the venue's own: a payment, a reader, a print job, or tonight's date. */
async function checkTarget(
  c: Queryable,
  venueId: string,
  action: string,
  target: string,
): Promise<void> {
  if (action === "close_night") {
    if (!DATE.test(target)) throw new ApiError("invalid_request", "name the night (YYYY-MM-DD)");
    return;
  }
  if (!UUID.test(target)) throw new ApiError("not_found", "no such target at this venue");
  const sql: Record<string, string> = {
    resync_payment: "select 1 from payments where venue_id = $1 and id = $2",
    cancel_reader_action:
      "select 1 from devices where venue_id = $1 and id = $2 and stripe_reader_id is not null",
    requeue_print: "select 1 from print_jobs where venue_id = $1 and id = $2",
  };
  const found = await c.query(sql[action]!, [venueId, target]);
  if ((found.rowCount ?? 0) === 0) throw new ApiError("not_found", "no such target at this venue");
}

export function emergencyConsoleRoutes(
  app: FastifyInstance,
  options: {
    pool: pg.Pool;
    clock: Clock;
    stripe: () => StripeClient;
    email: Pick<EmailSettings, "allowList">;
  },
): void {
  const read = route({ principals: ["console"], module: "core" });
  const write = route({ principals: ["console"], module: "core", idempotency: "optional" });
  const { pool, clock } = options;

  const staffOf = (request: FastifyRequest) => {
    const p = request.principal;
    if (p.kind !== "console") throw new ApiError("forbidden", "you can't call this");
    return { id: p.staffId, name: p.name };
  };
  const venueOrThrow = async (venueId: string) => {
    if (!UUID.test(venueId)) throw new ApiError("not_found", "no such venue");
    const venue = await consoleVenue(pool, venueId);
    if (!venue) throw new ApiError("not_found", "no such venue");
    return venue;
  };
  const idOrThrow = (id: string) => {
    if (!UUID.test(id)) throw new ApiError("not_found", "no such emergency action");
    return id;
  };

  app.get<{ Params: { v: string } }>(
    "/v1/console/venues/:v/emergency-actions",
    { config: read },
    async (request) => {
      const staff = staffOf(request);
      const venue = await venueOrThrow(request.params.v);
      const rows = await withVenue(
        pool,
        { venueId: venue.id, userId: staff.id, requestId: request.requestId },
        (c) => emergencyActions(c, venue.id),
      );
      const at = clock.now().epochMilliseconds;
      return { venue, emergency_actions: rows.map((e) => emergencyOut(e, at)) };
    },
  );

  // Ask: the action, its target, a reason (and a stuck night's named fixes). The owner is told now.
  app.post<{
    Params: { v: string };
    Body: { action?: unknown; target?: unknown; reason?: unknown; fixes?: unknown };
  }>("/v1/console/venues/:v/emergency-actions", { config: write }, async (request) => {
    const staff = staffOf(request);
    const venue = await venueOrThrow(request.params.v);
    const body = request.body ?? {};
    const action = body.action;
    if (!isEmergencyAction(action))
      throw new ApiError(
        "invalid_request",
        "only re-sync a payment, cancel a reader action, requeue a print or close a stuck night",
      );
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason.length < 3 || reason.length > 500)
      throw new ApiError("invalid_request", "give a reason (3 to 500 characters)");
    const target = typeof body.target === "string" ? body.target.trim() : "";
    const fixes = parseFixes(body.fixes);
    if (fixes.length > 0 && action !== "close_night")
      throw new ApiError("invalid_request", "only closing a stuck night takes fixes");
    const now = clock.now();
    const row = await withVenue(
      pool,
      { venueId: venue.id, userId: staff.id, requestId: request.requestId },
      async (c) => {
        await checkTarget(c, venue.id, action, target);
        const e = await requestEmergencyAction(c, {
          venueId: venue.id,
          staffId: staff.id,
          action,
          target,
          fixes,
          reason,
          at: now.toString(),
          minutes: EMERGENCY_APPROVAL_MINUTES,
        });
        await tellOwners(c, options.email, e, "opened", now);
        return e;
      },
    );
    return { emergency_action: emergencyOut(row, now.epochMilliseconds) };
  });

  /**
   * The second approver's yes: another of our staff, in their own Console session, before the
   * request's time box ends. It runs at once; the outcome and the owner's second notice follow.
   */
  app.post<{ Params: { v: string; emergencyId: string } }>(
    "/v1/console/venues/:v/emergency-actions/:emergencyId/approve",
    { config: write },
    async (request) => {
      const staff = staffOf(request);
      const venue = await venueOrThrow(request.params.v);
      const id = idOrThrow(request.params.emergencyId);
      const at = clock.now();
      const approved = await withVenue(
        pool,
        { venueId: venue.id, userId: staff.id, requestId: request.requestId },
        async (c) => {
          const before = await emergencyAction(c, venue.id, id);
          if (!before) throw new ApiError("not_found", "no such emergency action");
          if (before.requested_by === staff.id)
            throw new ApiError("forbidden", "a second person on our team approves it, not you");
          const after = await decideEmergencyAction(c, {
            venueId: venue.id,
            id,
            decision: "approve",
            staffId: staff.id,
            at: at.toString(),
          });
          if (!after)
            throw new ApiError("version_conflict", "this request isn't waiting any more", {
              details: { state: emergencyState(before, at.epochMilliseconds) },
            });
          return after;
        },
      );
      const done = await runEmergency(options, approved, request.requestId);
      return { emergency_action: emergencyOut(done, clock.now().epochMilliseconds) };
    },
  );

  app.post<{ Params: { v: string; emergencyId: string } }>(
    "/v1/console/venues/:v/emergency-actions/:emergencyId/decline",
    { config: write },
    async (request) => {
      const staff = staffOf(request);
      const venue = await venueOrThrow(request.params.v);
      const id = idOrThrow(request.params.emergencyId);
      const at = clock.now();
      const out = await withVenue(
        pool,
        { venueId: venue.id, userId: staff.id, requestId: request.requestId },
        async (c) => {
          const before = await emergencyAction(c, venue.id, id);
          if (!before) throw new ApiError("not_found", "no such emergency action");
          if (before.requested_by === staff.id)
            throw new ApiError("forbidden", "withdraw your own request instead");
          const after = await decideEmergencyAction(c, {
            venueId: venue.id,
            id,
            decision: "decline",
            staffId: staff.id,
            at: at.toString(),
          });
          if (!after)
            throw new ApiError("version_conflict", "this request isn't waiting any more", {
              details: { state: emergencyState(before, at.epochMilliseconds) },
            });
          return after;
        },
      );
      return { emergency_action: emergencyOut(out, at.epochMilliseconds) };
    },
  );

  app.post<{ Params: { v: string; emergencyId: string } }>(
    "/v1/console/venues/:v/emergency-actions/:emergencyId/withdraw",
    { config: write },
    async (request) => {
      const staff = staffOf(request);
      const venue = await venueOrThrow(request.params.v);
      const id = idOrThrow(request.params.emergencyId);
      const at = clock.now();
      const out = await withVenue(
        pool,
        { venueId: venue.id, userId: staff.id, requestId: request.requestId },
        async (c) => {
          const before = await emergencyAction(c, venue.id, id);
          if (!before) throw new ApiError("not_found", "no such emergency action");
          if (before.requested_by !== staff.id)
            throw new ApiError("forbidden", "only the one who asked withdraws it");
          const after = await withdrawEmergencyAction(c, {
            venueId: venue.id,
            id,
            staffId: staff.id,
          });
          if (!after) throw new ApiError("version_conflict", "this request isn't waiting any more");
          return after;
        },
      );
      return { emergency_action: emergencyOut(out, at.epochMilliseconds) };
    },
  );
}

/**
 * Runs an approved action, then records the outcome and tells the owner. Stripe is called only
 * outside a transaction, with an idempotency key; every transaction carries both identities.
 */
export async function runEmergency(
  options: {
    pool: pg.Pool;
    clock: Clock;
    stripe: () => StripeClient;
    email: Pick<EmailSettings, "allowList">;
  },
  e: EmergencyActionRow,
  requestId: string,
): Promise<EmergencyActionRow> {
  const { pool, clock } = options;
  const venueId = e.venue_id;
  const ctx: RequestContext = {
    venueId,
    userId: e.requested_by,
    requestId,
    emergency: { actionId: e.id, approverId: e.decided_by! },
  };
  let ok = true;
  let result: Record<string, unknown>;
  try {
    result = await runOne(options, e, ctx);
  } catch (error) {
    ok = false;
    if (error instanceof ApiError)
      result = { error: error.code, message: error.message, details: error.details ?? null };
    else if (error instanceof StripeError)
      result = { error: "stripe", code: error.code, message: error.message };
    else if (error instanceof StripeUnknownResult)
      // Not a payment: an unclear cancel is reported as such, never retried here.
      result = { error: "stripe_unknown", message: error.message };
    else throw error;
  }
  const now = clock.now();
  return withVenue(pool, ctx, async (c) => {
    const done = (await finishEmergencyAction(c, {
      venueId,
      id: e.id,
      ok,
      result,
      at: now.toString(),
    }))!;
    await tellOwners(c, options.email, done, ok ? "done" : "failed", now);
    return done;
  });
}

async function runOne(
  options: { pool: pg.Pool; clock: Clock; stripe: () => StripeClient },
  e: EmergencyActionRow,
  ctx: RequestContext,
): Promise<Record<string, unknown>> {
  const { pool, clock } = options;
  const venueId = e.venue_id;
  switch (e.action) {
    case "requeue_print": {
      const job = await withVenue(pool, ctx, (c) =>
        reprintJob(c, venueId, e.target, clock.now().toString()),
      );
      if (!job) throw new ApiError("not_found", "no such print job");
      return { print_job_id: job.id, reprint_n: job.reprint_n };
    }
    case "resync_payment": {
      // The payment state machine, run against Stripe for this one payment (the reconciler's read).
      const applied = await checkNow(
        { pool, stripe: options.stripe(), clock, context: ctx },
        venueId,
        e.target,
        "reconciler",
      );
      if (!applied) throw new ApiError("not_found", "no such payment");
      return {
        payment_status: applied.payment.status,
        attempt_state: applied.attempt?.state ?? null,
        changed: applied.changed,
      };
    }
    case "cancel_reader_action": {
      const found = await withVenue(pool, ctx, async (c) => ({
        reader: await readerOfVenue(c, venueId, e.target),
        account: await stripeAccountFor(c, venueId, false),
      }));
      if (!found.reader || !found.account) throw new ApiError("not_found", "no such reader");
      await cancelReaderAction(
        options.stripe(),
        found.account,
        found.reader.stripe_reader_id,
        `emergency:${e.id}:cancel_action`,
      );
      return { reader: found.reader.name, canceled: true };
    }
    case "close_night": {
      const now = clock.now();
      const fixes = e.fixes as NightFixInput[];
      return withVenue(pool, ctx, async (c) => {
        await applyNightFixes(c, venueId, fixes, now);
        const closed = await closeNight(c, {
          venueId,
          date: e.target,
          now,
          by: { kind: "support", staffId: e.requested_by, name: e.requested_by_name ?? "" },
        });
        return { ...closed, fixes: fixes.length };
      });
    }
    default:
      throw new ApiError("invalid_request", "not an emergency action");
  }
}

/** Admin → Console (N39): the owner reads the venue's emergency actions. */
export function emergencyVenueRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/emergency-actions",
    {
      config: route({
        principals: ["owner_manager"],
        module: "core",
        action: "admin.console",
        assurance: "passkey",
      }),
    },
    async (request) => {
      const venueId = request.venueId!;
      const p = request.principal;
      const here = p.kind === "user" ? p.memberships.find((m) => m.venueId === venueId) : undefined;
      if (here?.role !== "owner") throw new ApiError("forbidden", "Console is the owner's section");
      const rows = await request.inVenue((c) => emergencyActions(c, venueId));
      const at = options.clock.now().epochMilliseconds;
      return { emergency_actions: rows.map((e) => emergencyOut(e, at)) };
    },
  );
}
