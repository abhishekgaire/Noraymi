import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import {
  consoleCreateVenue,
  consoleOrganizations,
  consoleVenue,
  createInvite,
  type Queryable,
} from "@west4/db";
import { builtInRulePacks, type Clock } from "@west4/shared";
import type { EmailSettings } from "../email/settings.js";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { enqueueEmail } from "../jobs/send-email.js";
import { newInviteToken } from "../routes/team.js";

/**
 * New venue and the owner's invite (O-01; spec 17 · Who runs it, D113).
 * Our staff, signed in to the Console with their security key, make the
 * organization (or pick one already there, whose Stripe account the new venue
 * then shares), the venue and the owner's `invited` membership, and nothing
 * else: no hours, rooms, prices, settings or contacts. Every row is written
 * with the staff member as actor and the reason is kept in venue_onboarding.
 * The owner's invite is a 7-day link; Send again makes a new one and the old
 * one is refused as replaced. Opening it runs the staff app's invite path.
 */
export const OWNER_INVITE_DAYS = 7;

/** Phase 1 has one rule pack, New York's (spec 03); the address step confirms it. */
const NEW_YORK_RULE_PACK = builtInRulePacks[0]!.id;

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/, "lower-case letters, digits and dashes");

const newVenueBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    slug,
    org_id: z.string().uuid().optional(),
    legal_name: z.string().trim().min(1).max(160).optional(),
    owner_name: z.string().trim().min(1).max(80),
    owner_email: z.string().trim().email().max(254),
    reason: z.string().trim().min(3).max(500),
  })
  .strict()
  .refine((b) => (b.org_id === undefined) !== (b.legal_name === undefined), {
    message: "send an org_id or a legal_name, not both",
  });

/** The owner's membership and how far they got: invited (not yet signed in) or active. */
export interface OwnerState {
  readonly membership_id: string;
  readonly name: string;
  readonly email: string | null;
  readonly status: "invited" | "active" | "deactivated";
  /** When the newest open invite link stops working; null when none is open. */
  readonly invite_expires_at: string | null;
}

export async function ownerState(c: Queryable, venueId: string): Promise<OwnerState | null> {
  const r = await c.query<{
    membership_id: string;
    name: string;
    email: string | null;
    status: OwnerState["status"];
    invite_expires_at: Date | null;
  }>(
    `select m.id as membership_id, u.name, u.email, m.status,
            (select max(i.expires_at) from invites i
              where i.venue_id = m.venue_id and i.membership_id = m.id and i.used_at is null)
              as invite_expires_at
       from memberships m join users u on u.id = m.user_id
      where m.venue_id = $1 and m.role = 'owner'
      order by (m.status = 'active') desc, m.created_at
      limit 1`,
    [venueId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    membership_id: row.membership_id,
    name: row.name,
    email: row.email,
    status: row.status,
    invite_expires_at: row.invite_expires_at ? row.invite_expires_at.toISOString() : null,
  };
}

export function newVenueRoutes(
  app: FastifyInstance,
  options: {
    pool: pg.Pool;
    clock: Clock;
    email: Pick<EmailSettings, "allowList">;
    staffAppUrl: string | null;
  },
): void {
  const read = route({ principals: ["console"], module: "core" });
  const write = route({ principals: ["console"], module: "core", idempotency: "optional" });

  const staffOf = (request: { principal: { kind: string } }) => {
    const p = request.principal as { kind: string; staffId?: string };
    if (p.kind !== "console" || !p.staffId) throw new ApiError("forbidden", "you can't call this");
    return p.staffId;
  };

  const appUrl = (): string => {
    if (!options.staffAppUrl) throw new ApiError("internal", "STAFF_APP_URL isn't set");
    return options.staffAppUrl.replace(/\/$/, "");
  };

  app.get("/v1/console/organizations", { config: read }, async (request) => {
    const staffId = staffOf(request);
    // No venue: the definer door checks the staff member itself.
    const client = await options.pool.connect();
    try {
      await client.query("begin read only");
      await client.query("select set_config('app.user_id', $1, true)", [staffId]);
      const organizations = await consoleOrganizations(client);
      await client.query("commit");
      return { organizations };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });

  app.post<{ Body: unknown }>("/v1/console/venues", { config: write }, async (request, reply) => {
    const staffId = staffOf(request);
    const parsed = newVenueBody.safeParse(request.body);
    if (!parsed.success)
      throw new ApiError(
        "invalid_request",
        "send { name, slug, org_id or legal_name, owner_name, owner_email, reason }",
        { details: { issues: parsed.error.issues.map((i) => i.path.join(".") || i.message) } },
      );
    const b = parsed.data;
    const venueId = randomUUID();
    const made = await app.db
      .withVenue({ venueId, userId: staffId, requestId: request.requestId }, async (c) => {
        const { orgId, userId } = await consoleCreateVenue(c, {
          venueId,
          orgId: b.org_id ?? null,
          legalName: b.legal_name ?? null,
          name: b.name,
          slug: b.slug,
          rulePackId: NEW_YORK_RULE_PACK,
          ownerName: b.owner_name,
          ownerEmail: b.owner_email,
        });
        const m = await c.query<{ id: string }>(
          `insert into memberships (venue_id, user_id, role, status, pin_digits, locale)
             values ($1, $2, 'owner', 'invited', 6, 'en') returning id`,
          [venueId, userId],
        );
        await c.query(
          "insert into venue_onboarding (venue_id, created_by, reason) values ($1, $2, $3)",
          [venueId, staffId, b.reason],
        );
        const org = await c.query<{ stripe_account_id: string | null }>(
          "select stripe_account_id from organizations where id = $1",
          [orgId],
        );
        return {
          orgId,
          membershipId: m.rows[0]!.id,
          stripeAccountId: org.rows[0]?.stripe_account_id ?? null,
        };
      })
      .catch((error: unknown) => {
        const e = error as { code?: string; constraint?: string };
        if (e.code === "23505" && e.constraint === "venues_slug_key")
          throw new ApiError("invalid_request", "that web name is already taken", {
            status: 409,
            details: { field: "slug" },
          });
        if (e.code === "P0002") throw new ApiError("not_found", "no such organization");
        throw error;
      });
    const venue = await consoleVenue(options.pool, venueId);
    return reply.code(201).send({
      venue,
      org_id: made.orgId,
      stripe_account_id: made.stripeAccountId,
      owner: { membership_id: made.membershipId, status: "invited" },
    });
  });

  app.post<{ Params: { v: string } }>(
    "/v1/console/venues/:v/owner-invite",
    { config: write },
    async (request) => {
      const staffId = staffOf(request);
      const venueId = request.params.v;
      if (!/^[0-9a-f-]{36}$/i.test(venueId)) throw new ApiError("not_found", "no such venue");
      const venue = await consoleVenue(options.pool, venueId);
      if (!venue) throw new ApiError("not_found", "no such venue");
      const now = options.clock.now();
      const expiresAt = now.add({ hours: OWNER_INVITE_DAYS * 24 });
      const { token, hash } = newInviteToken();
      const sent = await app.db.withVenue(
        { venueId, userId: staffId, requestId: request.requestId },
        async (c) => {
          const owner = await ownerState(c, venueId);
          if (!owner) throw new ApiError("not_found", "this venue has no owner");
          if (owner.status !== "invited")
            throw new ApiError("invalid_request", "the owner has already signed in", {
              status: 409,
            });
          if (!owner.email) throw new ApiError("invalid_request", "the owner has no email");
          await createInvite(c, {
            venueId,
            membershipId: owner.membership_id,
            tokenHash: hash,
            createdBy: staffId,
            expiresAt: expiresAt.toString(),
          });
          await enqueueEmail(c, options.email, {
            venueId,
            runAt: now,
            to: owner.email,
            locale: "en",
            template: "owner_invite",
            data: {
              venueName: venue.name,
              ownerName: owner.name,
              inviteUrl: `${appUrl()}/invite/${token}`,
              expiresDays: OWNER_INVITE_DAYS,
            },
          });
          return owner.email;
        },
      );
      return { sent_to: sent, expires_at: expiresAt.toString() };
    },
  );
}
