import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import {
  createInvite,
  emitEvent,
  offboardMembership,
  rulePackFor,
  setPinVerifier,
  sha256Hex,
  type Queryable,
} from "@west4/db";
import type { Clock } from "@west4/shared";
import { businessDate } from "@west4/rules";
import { venueClock } from "../rooms/assignment.js";
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

const patchBody = z
  .object({
    role: z.enum(["owner", "manager", "bartender", "front_desk", "staff"]).optional(),
    locale: z.enum(["en", "es"]).optional(),
    training: z.boolean().optional(),
    // M7-09: tip eligibility and the occupation the pool reads, from the next business date.
    tip_eligible: z.boolean().optional(),
    occupation_code: z.string().trim().min(1).max(40).nullable().optional(),
  })
  .strict();

interface TeamRow {
  readonly membership_id: string;
  readonly name: string;
  readonly email: string | null;
  readonly role: string;
  readonly status: "invited" | "active" | "deactivated";
  readonly locale: "en" | "es";
  readonly training: boolean;
  readonly tip_eligible: boolean;
  readonly occupation_code: string | null;
  readonly has_pin: boolean;
  readonly deactivated_at: string | null;
  readonly invite_expires_at: string | null;
}

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

  /**
   * Clears the person's PIN at once and sends a fresh link to their own phone
   * (or their email until a phone is confirmed). Shared by a PIN reset and a
   * role change that moves them between 4- and 6-digit PINs.
   */
  const sendPinLink = async (
    c: Queryable,
    venueId: string,
    membershipId: string,
    actorUserId: string,
    expiresAt: string,
    /** A role change clears the PIN even when there's no phone or email to send the link to; a reset refuses. */
    quiet = false,
  ): Promise<"text" | "email" | null> => {
    const { token, hash } = newInviteToken();
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
      [venueId, membershipId],
    );
    const row = m.rows[0];
    if (!row) throw new ApiError("not_found", "no such person at this venue");
    // The old PIN stops at once, before the new link is even opened.
    await setPinVerifier(c, venueId, membershipId, null);
    await createInvite(c, {
      venueId,
      membershipId,
      tokenHash: hash,
      createdBy: actorUserId,
      expiresAt,
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
      return "text";
    }
    if (!row.email) {
      if (quiet) return null;
      throw new ApiError("invalid_request", "this person has no confirmed phone or email");
    }
    const inviter = await c.query<{ name: string }>("select name from users where id = $1", [
      actorUserId,
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
    return "email";
  };

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
      const sentBy = await request.inVenue((c) =>
        sendPinLink(c, venueId, request.params.m, p.userId, expiresAt.toString()),
      );
      return reply.code(202).send({ sent_by: sentBy, expires_at: expiresAt.toString() });
    },
  );

  /**
   * Admin → Team (M1-31), owner only: every person at the venue with their
   * role, invite state, language and badges. Deactivated people stay listed
   * (their records are kept) so the owner can see who was let go.
   */
  app.get<{ Params: VenueParams }>(
    "/v1/venues/:venueId/team",
    {
      config: route({
        principals: ["owner_manager"],
        module: "core",
        action: "admin.team",
        assurance: "passkey",
      }),
    },
    async (request) => {
      const venueId = request.venueId!;
      // The permission gate guards writes; this read is the owner's too (spec 02: Team is owner only).
      const p = request.principal;
      const here = p.kind === "user" ? p.memberships.find((m) => m.venueId === venueId) : undefined;
      if (here?.role !== "owner") throw new ApiError("forbidden", "Team is the owner's section");
      return request.inVenue(async (c) => {
        const people = await c.query<TeamRow>(
          `select m.id as membership_id, u.name, u.email, m.role, m.status, m.locale, m.training,
                  m.tip_eligible, m.occupation_code, m.pin_verifier is not null as has_pin, m.deactivated_at::text,
                  (select max(i.expires_at)::text from invites i
                    where i.venue_id = m.venue_id and i.membership_id = m.id and i.used_at is null
                      and i.expires_at > $2) as invite_expires_at
             from memberships m join users u on u.id = m.user_id
            where m.venue_id = $1
            order by case m.status when 'active' then 0 when 'invited' then 1 else 2 end,
                     array_position(array['owner','manager','bartender','front_desk','staff'], m.role),
                     u.name`,
          [venueId, options.clock.now().toString()],
        );
        const badges = await c.query<{
          id: string;
          membership_id: string;
          label: string;
          disabled_at: string | null;
        }>(
          `select id, membership_id, label, disabled_at::text
             from staff_badges where venue_id = $1 order by paired_at`,
          [venueId],
        );
        return {
          people: people.rows.map((row) => ({
            ...row,
            badges: badges.rows
              .filter((b) => b.membership_id === row.membership_id)
              .map(({ id, label, disabled_at }) => ({ id, label, disabled_at })),
          })),
        };
      });
    },
  );

  /**
   * `PATCH /team/{m}` (spec 08): the owner, asked for the passkey again, sets a
   * person's role, language or training mode (M7-03: practice checks only, a
   * permanent band on every screen they sign in on). A role change that
   * moves someone between 4- and 6-digit PINs clears the old PIN and sends a
   * new link, the same way a reset does, because the old length no longer
   * fits (cautious default). Nobody changes their own role, so a venue can't
   * lose its last owner by mistake. The audit trigger on memberships records
   * the change.
   */
  app.patch<{ Params: VenueParams & { m: string }; Body: unknown }>(
    "/v1/venues/:venueId/team/:m",
    { config: teamChange },
    async (request, reply) => {
      const p = request.principal;
      if (p.kind !== "user") throw new ApiError("forbidden", "you can't call this");
      const parsed = patchBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError("invalid_request", "send { role }, { locale } and/or { training }", {
          details: { issues: parsed.error.issues.map((i) => i.message) },
        });
      const body = parsed.data;
      if (
        body.role === undefined &&
        body.locale === undefined &&
        body.training === undefined &&
        body.tip_eligible === undefined &&
        body.occupation_code === undefined
      )
        throw new ApiError("invalid_request", "nothing to change");
      const venueId = request.venueId!;
      const here = p.memberships.find((m) => m.venueId === venueId);
      if (body.role !== undefined && here?.membershipId === request.params.m)
        throw new ApiError("invalid_request", "you can't change your own role");
      const result = await request.inVenue(async (c) => {
        const current = await c.query<{
          role: string;
          locale: string;
          status: string;
          training: boolean;
          tip_eligible: boolean;
          occupation_code: string | null;
        }>(
          `select role, locale, status, training, tip_eligible, occupation_code from memberships
            where venue_id = $1 and id = $2 and status <> 'deactivated' for update`,
          [venueId, request.params.m],
        );
        const row = current.rows[0];
        if (!row) throw new ApiError("not_found", "no such active person at this venue");
        const role = body.role ?? row.role;
        const locale = body.locale ?? row.locale;
        const training = body.training ?? row.training;
        // Tip eligibility (M7-09): owners and managers never share when the rule pack says so.
        const eligible = body.tip_eligible ?? row.tip_eligible;
        const occupation =
          body.occupation_code === undefined ? row.occupation_code : body.occupation_code;
        if (body.tip_eligible === true && (role === "owner" || role === "manager")) {
          const venue = await venueClock(c, venueId);
          const date = businessDate(
            options.clock.now(),
            venue.timeZone,
            venue.dayCutover,
          ).businessDate;
          const rv = await c.query<{ rule_pack_id: string | null }>(
            "select rule_pack_id from venues where id = $1",
            [venueId],
          );
          const pack = await rulePackFor(
            c,
            rv.rows[0]?.rule_pack_id ?? "us-ny-new-york-county",
            date,
          );
          if (!(pack?.pack.gratuity.managersShare ?? false))
            throw new ApiError(
              "invalid_request",
              "owners and managers never share tips or gratuity here",
              {
                details: { reason: "managers_share" },
              },
            );
        }
        const eligibilityChanged =
          eligible !== row.tip_eligible || occupation !== row.occupation_code;
        const digitsChange =
          body.role !== undefined && pinDigitsFor(body.role) !== pinDigitsFor(row.role);
        await c.query(
          `update memberships set role = $3, locale = $4, pin_digits = $5, training = $6
            where venue_id = $1 and id = $2`,
          [venueId, request.params.m, role, locale, pinDigitsFor(role), training],
        );
        if (eligibilityChanged)
          await c.query(
            `update memberships set tip_eligible = $3, occupation_code = $4, eligibility_set_by = $5,
                    eligibility_set_at = $6
              where venue_id = $1 and id = $2`,
            [
              venueId,
              request.params.m,
              eligible,
              occupation,
              p.userId,
              options.clock.now().toString(),
            ],
          );
        let pinResetSentBy: "text" | "email" | null = null;
        if (digitsChange && row.status === "active") {
          pinResetSentBy = await sendPinLink(
            c,
            venueId,
            request.params.m,
            p.userId,
            options.clock.now().add({ hours: INVITE_HOURS }).toString(),
            true,
          );
        }
        await emitEvent(c, {
          venueId,
          type: "membership.changed",
          entityId: request.params.m,
          entityVersion: 0,
        });
        return { role, locale, training, eligible, occupation, pinResetSentBy };
      });
      return reply.code(200).send({
        membership_id: request.params.m,
        role: result.role,
        locale: result.locale,
        training: result.training,
        tip_eligible: result.eligible,
        occupation_code: result.occupation,
        pin_reset_sent_by: result.pinResetSentBy,
      });
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
