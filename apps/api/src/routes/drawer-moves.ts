import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  drawerOfDevice,
  drawerSessionById,
  emitEvent,
  insertDrawerMove,
  insertPrintJob,
  readSetting,
  staffBankOf,
  type DrawerSessionRow,
  type Queryable,
} from "@west4/db";
import { Temporal, type CashSettings, type Clock } from "@west4/shared";
import { z } from "zod";
import { requestApproval, executors, TargetGone } from "../approvals/service.js";
import { attachFile } from "../files/storage.js";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { mayCount } from "./drawers.js";
import { ownDrawerOnly } from "../payments/cash.js";

/**
 * Drops, paid-outs, no-sales and tip-outs at the drawer (M7-06; Money rules
 * 15; spec 08 · Drawer; spec 09 · Cash drawer):
 *   POST /v1/venues/{v}/drawer-sessions/{s}/drop      hand your staff bank in at the drawer's own screen
 *   POST /v1/venues/{v}/drawer-sessions/{s}/paid-out  cash out for an expense, with a reason and the receipt's photo
 *   POST /v1/venues/{v}/drawer-sessions/{s}/no-sale   open the drawer with nothing sold (PIN again)
 *   POST /v1/venues/{v}/drawer-sessions/{s}/tip-out   a manager pays tips in cash to a named person (PIN again)
 * Each happens at the drawer's own screen, writes one move on the open
 * session with who took it and where, and opens the drawer through its
 * printer's kick port. A paid-out over `drawer.paidOutApprovalCents` answers
 * 202 and waits for an approval; the move and the kick happen only once it's
 * approved. Nothing here runs in training: the drawer never opens for practice.
 */
type Role = "owner" | "manager" | "bartender" | "front_desk" | "staff";
interface Actor {
  readonly userId: string;
  readonly role: Role;
  readonly deviceId: string | null;
}

function actorOf(request: FastifyRequest): Actor {
  const p = request.principal;
  if (p.kind !== "user") throw new ApiError("forbidden", "a drawer move needs a person signed in");
  const m = p.memberships.find((x) => x.venueId === request.venueId);
  if (!m) throw new ApiError("forbidden", "not a member of this venue");
  if (request.training)
    throw new ApiError("invalid_request", "the drawer doesn't open in training", {
      details: { reason: "training" },
    });
  return {
    userId: p.userId,
    role: m.role,
    deviceId: request.signedDevice?.deviceId ?? request.session?.deviceId ?? null,
  };
}

/** No-sale and tip-out ask for the PIN again in a PIN or badge session (spec 02 · Badges). */
async function pinAgain(request: FastifyRequest, pin: string | undefined): Promise<void> {
  const p = request.principal;
  if (p.kind !== "user" || (p.session !== "pin" && p.session !== "badge")) return;
  if (!pin)
    throw new ApiError("invalid_request", "this asks for your PIN again", {
      details: { reason: "pin" },
    });
  await request.server.checkPinAgain(request, pin);
}

/** The open session, at its drawer's own screen. */
async function atTheDrawer(
  c: Queryable,
  venueId: string,
  sessionId: string,
  deviceId: string | null,
  userId?: string,
): Promise<DrawerSessionRow> {
  const session = await drawerSessionById(c, venueId, sessionId, true);
  if (!session) throw new ApiError("not_found", "no such drawer session");
  if (session.state !== "open")
    throw new ApiError("version_conflict", `this drawer is ${session.state}`);
  const here = deviceId ? await drawerOfDevice(c, venueId, deviceId) : null;
  if (here?.session_id !== sessionId)
    throw new ApiError("forbidden", "this happens at the drawer's own screen");
  // A drawer per person opens only for its owner (M7-07).
  if (userId) await ownDrawerOnly(c, venueId, sessionId, userId);
  return session;
}

/** Opens the drawer through its printer's kick port, with the move behind it. */
async function kick(
  c: Queryable,
  venueId: string,
  session: DrawerSessionRow,
  reason: "drop" | "paid_out" | "no_sale" | "tip_out",
  moveId: string,
  at: Temporal.Instant,
): Promise<void> {
  const printer = (
    await c.query<{ printer_device_id: string | null }>(
      "select printer_device_id from cash_drawers where venue_id = $1 and id = $2",
      [venueId, session.drawer_id],
    )
  ).rows[0]?.printer_device_id;
  if (!printer) return;
  await insertPrintJob(c, venueId, {
    kind: "drawer",
    station: session.station ?? "bar",
    deviceId: printer,
    payload: { reason, move_id: moveId, drawer_id: session.drawer_id },
    createdAt: at.toString(),
  });
}

async function firstName(c: Queryable, userId: string): Promise<string> {
  return (
    (
      await c.query<{ name: string }>(
        "select split_part(name, ' ', 1) as name from users where id = $1",
        [userId],
      )
    ).rows[0]?.name ?? ""
  );
}

const uuid = z.string().uuid();
const pin = z
  .string()
  .regex(/^\d{4,6}$/)
  .optional();
const paidOutBody = z
  .object({
    amount_cents: z.number().int().min(1).max(10_000_000),
    reason: z.string().trim().min(1).max(200),
    photo_file_id: uuid,
  })
  .strict();
const noSaleBody = z.object({ reason: z.string().trim().min(1).max(200), pin }).strict();
const tipOutBody = z
  .object({ paid_to: uuid, amount_cents: z.number().int().min(1).max(10_000_000), pin })
  .strict();

export function drawerMoveRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  const config = route({
    principals: ["owner_manager", "staff"],
    module: "core",
    idempotency: "optional",
  });
  const sessionId = (request: FastifyRequest<{ Params: { s: string } }>) => {
    if (!uuid.safeParse(request.params.s).success)
      throw new ApiError("not_found", "no such drawer session");
    return request.params.s;
  };

  // A drop: the person's staff bank for the session's business date goes into the drawer, all of it.
  app.post<{ Params: { venueId: string; s: string } }>(
    "/v1/venues/:venueId/drawer-sessions/:s/drop",
    { config },
    async (request) => {
      const s = sessionId(request);
      const actor = actorOf(request);
      const venueId = request.venueId!;
      const now = options.clock.now();
      return request.inVenue(async (c) => {
        const session = await atTheDrawer(c, venueId, s, actor.deviceId, actor.userId);
        const bank = await staffBankOf(c, venueId, actor.userId, session.business_date);
        if (!bank || bank.cash_cents <= 0)
          throw new ApiError("invalid_request", "there's no cash in your staff bank to drop", {
            details: { reason: "empty" },
          });
        const moveId = await insertDrawerMove(c, venueId, {
          drawerSessionId: s,
          kind: "drop",
          amountCents: bank.cash_cents,
          takenBy: actor.userId,
          deviceId: actor.deviceId,
          at: now.toString(),
        });
        await c.query(
          `update staff_banks set cash_cents = 0, dropped_at = $3, dropped_into_session_id = $4
            where venue_id = $1 and id = $2`,
          [venueId, bank.id, now.toString(), s],
        );
        await kick(c, venueId, session, "drop", moveId, now);
        await emitEvent(c, { venueId, type: "drawer.updated", entityId: session.drawer_id });
        return {
          move_id: moveId,
          amount_cents: bank.cash_cents,
          bank_cents: 0,
          logged_to: { name: await firstName(c, actor.userId), drawer: session.drawer_name },
        };
      });
    },
  );

  app.post<{ Params: { venueId: string; s: string }; Body: unknown }>(
    "/v1/venues/:venueId/drawer-sessions/:s/paid-out",
    { config },
    async (request, reply: FastifyReply) => {
      const s = sessionId(request);
      const parsed = paidOutBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError("invalid_request", "send { amount_cents, reason, photo_file_id }");
      const body = parsed.data;
      const actor = actorOf(request);
      const venueId = request.venueId!;
      const now = options.clock.now();
      const answer = await request.inVenue(async (c) => {
        const session = await atTheDrawer(c, venueId, s, actor.deviceId, actor.userId);
        if (!mayCount(actor.role, session.station))
          throw new ApiError("forbidden", "a paid-out is taken by the people who work this drawer");
        const file = (
          await c.query<{ kind: string }>(
            "select kind from files where venue_id = $1 and id = $2 and removed_at is null",
            [venueId, body.photo_file_id],
          )
        ).rows[0];
        if (file?.kind !== "paid_out_photo")
          throw new ApiError("invalid_request", "add a photo of the receipt", {
            details: { reason: "photo" },
          });
        await attachFile(c, venueId, body.photo_file_id, now);
        const setting = (
          await readSetting(c, venueId, "drawer", Temporal.PlainDate.from(session.business_date))
        )?.value as CashSettings | undefined;
        const limit = setting?.paidOutApprovalCents ?? 0;
        if (body.amount_cents > limit)
          return {
            pending: await requestApproval(c, venueId, {
              kind: "paid_out",
              targetKind: "drawer_session",
              targetId: s,
              amountCents: body.amount_cents,
              reason: body.reason,
              payload: {
                session_id: s,
                amount_cents: body.amount_cents,
                reason: body.reason,
                photo_file_id: body.photo_file_id,
                taken_by: actor.userId,
                device_id: actor.deviceId,
              },
              requestedBy: actor.userId,
              requestedDeviceId: actor.deviceId,
              now,
            }),
          };
        const moveId = await insertDrawerMove(c, venueId, {
          drawerSessionId: s,
          kind: "paid_out",
          amountCents: body.amount_cents,
          takenBy: actor.userId,
          deviceId: actor.deviceId,
          reason: body.reason,
          photoFileId: body.photo_file_id,
          at: now.toString(),
        });
        await kick(c, venueId, session, "paid_out", moveId, now);
        await emitEvent(c, { venueId, type: "drawer.updated", entityId: session.drawer_id });
        return { move_id: moveId, amount_cents: body.amount_cents };
      });
      if ("pending" in answer) return reply.code(202).send(answer.pending);
      return answer;
    },
  );

  app.post<{ Params: { venueId: string; s: string }; Body: unknown }>(
    "/v1/venues/:venueId/drawer-sessions/:s/no-sale",
    { config },
    async (request) => {
      const s = sessionId(request);
      const parsed = noSaleBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { reason }");
      const actor = actorOf(request);
      const venueId = request.venueId!;
      const session = await request.inVenue((c) => drawerSessionById(c, venueId, s));
      if (!session) throw new ApiError("not_found", "no such drawer session");
      if (!mayCount(actor.role, session.station))
        throw new ApiError("forbidden", "a no-sale is for the people who work this drawer");
      await pinAgain(request, parsed.data.pin);
      const now = options.clock.now();
      return request.inVenue(async (c) => {
        const open = await atTheDrawer(c, venueId, s, actor.deviceId, actor.userId);
        const moveId = await insertDrawerMove(c, venueId, {
          drawerSessionId: s,
          kind: "no_sale",
          amountCents: 0,
          takenBy: actor.userId,
          deviceId: actor.deviceId,
          reason: parsed.data.reason,
          at: now.toString(),
        });
        await kick(c, venueId, open, "no_sale", moveId, now);
        await emitEvent(c, { venueId, type: "drawer.updated", entityId: open.drawer_id });
        return { move_id: moveId };
      });
    },
  );

  app.post<{ Params: { venueId: string; s: string }; Body: unknown }>(
    "/v1/venues/:venueId/drawer-sessions/:s/tip-out",
    { config },
    async (request) => {
      const s = sessionId(request);
      const parsed = tipOutBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { paid_to, amount_cents }");
      const actor = actorOf(request);
      if (actor.role !== "owner" && actor.role !== "manager")
        throw new ApiError("forbidden", "a manager pays tips out of the drawer");
      const venueId = request.venueId!;
      await pinAgain(request, parsed.data.pin);
      const now = options.clock.now();
      return request.inVenue(async (c) => {
        const session = await atTheDrawer(c, venueId, s, actor.deviceId, actor.userId);
        const paid = await c.query(
          "select 1 from memberships where venue_id = $1 and user_id = $2 and status = 'active'",
          [venueId, parsed.data.paid_to],
        );
        if (paid.rowCount === 0)
          throw new ApiError("invalid_request", "pay tips to someone on the team");
        const moveId = await insertDrawerMove(c, venueId, {
          drawerSessionId: s,
          kind: "tip_out",
          amountCents: parsed.data.amount_cents,
          takenBy: actor.userId,
          deviceId: actor.deviceId,
          paidTo: parsed.data.paid_to,
          at: now.toString(),
        });
        await kick(c, venueId, session, "tip_out", moveId, now);
        await emitEvent(c, { venueId, type: "drawer.updated", entityId: session.drawer_id });
        return { move_id: moveId, amount_cents: parsed.data.amount_cents };
      });
    },
  );
}

/**
 * An approved paid-out (decided on the approver's own phone): the cash goes
 * out now, and the drawer opens. A session closed since is gone: it expires.
 */
executors.set("paid_out", async (c, venueId, approval, ctx) => {
  const p = approval.payload as {
    session_id: string;
    amount_cents: number;
    reason: string;
    photo_file_id: string;
    taken_by: string;
    device_id: string | null;
  };
  const session = await drawerSessionById(c, venueId, p.session_id, true);
  if (!session || session.state !== "open") throw new TargetGone();
  const moveId = await insertDrawerMove(c, venueId, {
    drawerSessionId: p.session_id,
    kind: "paid_out",
    amountCents: p.amount_cents,
    takenBy: p.taken_by,
    deviceId: p.device_id,
    reason: p.reason,
    photoFileId: p.photo_file_id,
    approvedBy: ctx.approverId,
    at: ctx.at.toString(),
  });
  await kick(c, venueId, session, "paid_out", moveId, ctx.at);
  await emitEvent(c, { venueId, type: "drawer.updated", entityId: session.drawer_id });
});
