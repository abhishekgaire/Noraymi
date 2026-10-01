import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { createInvite, emitEvent, offboardMembership, setPinVerifier, sha256Hex } from "@west4/db";
import type { Clock } from "@west4/shared";
import type { EmailSettings } from "../email/settings.js";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { enqueueEmail } from "../jobs/send-email.js";
import { enqueueText } from "../jobs/send-text.js";

/**
 * Admin → Team: invites and PIN resets (M1-23, spec 02). The owner or a
 * manager, in a passkey session asked again (team changes step up), invites a
 * person by email; the link opens on the person's own phone. A reset clears
 * the old PIN at once (cautious default) and sends a new link to the person's
 * phone, or to their email until a phone is confirmed.
 */
export const INVITE_HOURS = 48;

type VenueParams = { venueId: string };

const inviteBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    email: z.string().trim().email().max(254),
    role: z.enum(["owner", "manager", "bartender", "front_desk", "staff"]),
    locale: z.enum(["en", "es"]).optional(),
  })
  .strict();

export const pinDigitsFor = (role: string): 4 | 6 =>
  role === "owner" || role === "manager" ? 6 : 4;

export function newInviteToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: sha256Hex(token) };
}

export function teamRoutes(
  app: FastifyInstance,
  options: { clock: Clock; email: Pick<EmailSettings, "allowList">; staffAppUrl: string | null },
): void {
  const teamChange = route({
    principals: ["owner_manager"],
    module: "core",
    action: "admin.team",
    assurance: "passkey",
    stepUp: true,
    idempotency: "optional",
    tokenRoute: true,
  });

  /** Invite links need the staff app's public address; until it's set, inviting is a clear error, not a broken link. */
  const appUrl = (): string => {
    if (!options.staffAppUrl) throw new ApiError("internal", "STAFF_APP_URL is not set");
    return options.staffAppUrl;
  };

  const venueName = async (c: pg.PoolClient | { query: pg.PoolClient["query"] }, venueId: string) =>
    (await c.query<{ name: string }>("select name from venues where id = $1", [venueId])).rows[0]!
      .name;

  app.post<{ Params: VenueParams; Body: unknown }>(
    "/v1/venues/:venueId/team/invite",
    { config: teamChange },
    async (request, reply) => {
      const p = request.principal;
      if (p.kind !== "user") throw new ApiError("forbidden", "you can't call this");
      const parsed = inviteBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError("invalid_request", "send { name, email, role, locale? }");
      const body = parsed.data;
      const venueId = request.venueId!;
      const expiresAt = options.clock.now().add({ hours: INVITE_HOURS });
      const { token, hash } = newInviteToken();
      const made = await request.inVenue(async (c) => {
        const inviter = await c.query<{ name: string }>("select name from users where id = $1", [
          p.userId,
        ]);
        const user = await c.query<{ id: string }>(
          "insert into users (name, email) values ($1, $2) returning id",
          [body.name, body.email],
        );
        const membership = await c.query<{ id: string }>(
          `insert into memberships (venue_id, user_id, role, status, pin_digits, locale)
           values ($1, $2, $3, 'invited', $4, $5) returning id`,
          [venueId, user.rows[0]!.id, body.role, pinDigitsFor(body.role), body.locale ?? "en"],
        );
        const membershipId = membership.rows[0]!.id;
        const inviteId = await createInvite(c, {
          venueId,
          membershipId,
          tokenHash: hash,
          createdBy: p.userId,
          expiresAt: expiresAt.toString(),
        });
        await enqueueEmail(c, options.email, {
          venueId,
          runAt: options.clock.now(),
          to: body.email,
          locale: body.locale ?? "en",
          template: "invite",
          data: {
            venueName: await venueName(c, venueId),
            inviteeName: body.name,
            inviterName: inviter.rows[0]?.name ?? "",
            inviteUrl: `${appUrl()}/invite/${token}`,
            expiresHours: INVITE_HOURS,
          },
        });
        return { membershipId, inviteId };
      });
      return reply.code(201).send({
        membership_id: made.membershipId,
        invite_id: made.inviteId,
        expires_at: expiresAt.toString(),
      });
    },
  );

  app.post<{ Params: VenueParams & { m: string } }>(
    "/v1/venues/:venueId/team/:m/reset-pin",
    { config: teamChange },
    async (request, reply) => {
      const p = request.principal;
      if (p.kind !== "user") throw new ApiError("forbidden", "you can't call this");
      const venueId = request.venueId!;
      const expiresAt = options.clock.now().add({ hours: INVITE_HOURS });
      const { token, hash } = newInviteToken();
      const sentBy = await request.inVenue(async (c) => {
        const m = await c.query<{
          user_id: string;
          locale: "en" | "es";
          name: string;
          email: string | null;
          phone_e164: string | null;
          phone_verified_at: string | null;
        }>(
          `select m.user_id, m.locale, u.name, u.email, u.phone_e164, u.phone_verified_at::text
           from memberships m join users u on u.id = m.user_id
           where m.venue_id = $1 and m.id = $2 and m.status <> 'deactivated'`,
          [venueId, request.params.m],
        );
        const row = m.rows[0];
        if (!row) throw new ApiError("not_found", "no such person at this venue");
        // The old PIN stops at once, before the new link is even opened.
        await setPinVerifier(c, venueId, request.params.m, null);
        await createInvite(c, {
          venueId,
          membershipId: request.params.m,
          tokenHash: hash,
          createdBy: p.userId,
          expiresAt: expiresAt.toString(),
        });
        const url = `${appUrl()}/invite/${token}`;
        const name = await venueName(c, venueId);
        if (row.phone_e164 && row.phone_verified_at) {
          await enqueueText(c, {
            venueId,
            runAt: options.clock.now(),
            template: "pin_reset_link",
            to: row.phone_e164,
            locale: row.locale,
            data: { venueName: name, url, hours: INVITE_HOURS },
          });
          return "text" as const;
        }
        if (!row.email)
          throw new ApiError("invalid_request", "this person has no confirmed phone or email");
        const inviter = await c.query<{ name: string }>("select name from users where id = $1", [
          p.userId,
        ]);
        await enqueueEmail(c, options.email, {
          venueId,
          runAt: options.clock.now(),
          to: row.email,
          locale: row.locale,
          template: "invite",
          data: {
            venueName: name,
            inviteeName: row.name,
            inviterName: inviter.rows[0]?.name ?? "",
            inviteUrl: url,
            expiresHours: INVITE_HOURS,
          },
        });
        return "email" as const;
      });
      return reply.code(202).send({ sent_by: sentBy, expires_at: expiresAt.toString() });
    },
  );

  /**
   * Offboarding (spec 02 · Offboarding): the owner, in a passkey session asked
   * again, deactivates a person in one step. Everything they made stays.
   */
  app.post<{ Params: VenueParams & { m: string } }>(
    "/v1/venues/:venueId/team/:m/deactivate",
    { config: teamChange },
    async (request, reply) => {
      const p = request.principal;
      if (p.kind !== "user") throw new ApiError("forbidden", "you can't call this");
      const venueId = request.venueId!;
      const here = p.memberships.find((m) => m.venueId === venueId);
      if (here?.role !== "owner")
        throw new ApiError("forbidden", "only the owner deactivates a person");
      if (here.membershipId === request.params.m)
        throw new ApiError("invalid_request", "you can't deactivate yourself");
      const at = options.clock.now().toString();
      const done = await request.inVenue(async (c) => {
        const result = await offboardMembership(c, { venueId, membershipId: request.params.m, at });
        if (!result) throw new ApiError("not_found", "no such active person at this venue");
        await emitEvent(c, {
          venueId,
          type: "membership.deactivated",
          entityId: request.params.m,
          entityVersion: 0,
        });
        return result;
      });
      // After the commit: their sockets close now; their next request is refused by the authenticators.
      app.events.closeSocketsForUser(done.userId);
      return reply.code(200).send({
        membership_id: request.params.m,
        deactivated_at: at,
        badges_disabled: done.badgesDisabled,
        phones_revoked: done.phonesRevoked.length,
        sessions_ended: done.sessionsEnded,
      });
    },
  );
}
