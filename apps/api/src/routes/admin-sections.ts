import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { emitEvent } from "@west4/db";
import { grantableAdminSections, type Clock, type GrantableAdminSection } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { liveGrants, type PermissionGate } from "../http/permission-gate.js";

/**
 * Can also open (P-10; spec 02 · Roles), in Admin → Team, the owner's alone:
 *   GET /v1/venues/{v}/admin-sections              the sections a person can be given, and each person's live grants
 *   PUT /v1/venues/{v}/team/{m}/admin-sections     { sections }: this person's whole list, asked for the passkey again
 * Never Payments, Team or Console; an owner or a manager already opens every grantable section, so
 * only the other roles get grants. Each grant and each one taken back is a row the audit trigger
 * records; the API opens a granted section's routes in a passkey session only.
 */
type VenueParams = { venueId: string };

const putBody = z
  .object({
    sections: z
      .array(z.enum(grantableAdminSections as unknown as [string, ...string[]]))
      .max(grantableAdminSections.length),
  })
  .strict();

export function adminSectionRoutes(
  app: FastifyInstance,
  options: { clock: Clock; gate: PermissionGate },
): void {
  const ownerOnly = (request: FastifyRequest) => {
    const p = request.principal;
    const here =
      p.kind === "user" ? p.memberships.find((m) => m.venueId === request.venueId) : undefined;
    if (here?.role !== "owner")
      throw new ApiError("forbidden", "only the owner chooses what a person can also open");
    return { userId: (p as { userId: string }).userId };
  };

  app.get<{ Params: VenueParams }>(
    "/v1/venues/:venueId/admin-sections",
    {
      config: route({
        principals: ["owner_manager"],
        module: "core",
        action: "admin.team",
        assurance: "passkey",
      }),
    },
    async (request) => {
      ownerOnly(request);
      const venueId = request.venueId!;
      const rows = await request.inVenue(async (c) => {
        const r = await c.query<{ membership_id: string; section: string }>(
          `select membership_id, section from admin_section_grants
            where venue_id = $1 and revoked_at is null order by membership_id, section`,
          [venueId],
        );
        return r.rows;
      });
      const people = new Map<string, string[]>();
      for (const row of rows)
        people.set(row.membership_id, [...(people.get(row.membership_id) ?? []), row.section]);
      return {
        grantable: grantableAdminSections,
        people: [...people].map(([membership_id, sections]) => ({ membership_id, sections })),
      };
    },
  );

  app.put<{ Params: VenueParams & { m: string }; Body: unknown }>(
    "/v1/venues/:venueId/team/:m/admin-sections",
    {
      config: route({
        principals: ["owner_manager"],
        module: "core",
        action: "admin.team",
        assurance: "passkey",
        stepUp: true,
        idempotency: "optional",
      }),
    },
    async (request) => {
      const { userId } = ownerOnly(request);
      if (!z.string().uuid().safeParse(request.params.m).success)
        throw new ApiError("not_found", "no such person at this venue");
      const parsed = putBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError(
          "invalid_request",
          `send { sections }: any of ${grantableAdminSections.join(", ")}`,
        );
      const wanted = [...new Set(parsed.data.sections)] as GrantableAdminSection[];
      const venueId = request.venueId!;
      const membershipId = request.params.m;
      const now = options.clock.now().toString();
      const sections = await request.inVenue(async (c) => {
        const person = await c.query<{ role: string }>(
          `select role from memberships
            where venue_id = $1 and id = $2 and status <> 'deactivated' for update`,
          [venueId, membershipId],
        );
        const role = person.rows[0]?.role;
        if (!role) throw new ApiError("not_found", "no such active person at this venue");
        if ((role === "owner" || role === "manager") && wanted.length > 0)
          throw new ApiError(
            "invalid_request",
            "an owner's or a manager's role already opens these",
            {
              details: { reason: "role_has_them" },
            },
          );
        const have = await liveGrants(c, venueId, membershipId);
        for (const section of have.filter((s) => !wanted.includes(s)))
          await c.query(
            `update admin_section_grants set revoked_by = $4, revoked_at = $5
              where venue_id = $1 and membership_id = $2 and section = $3 and revoked_at is null`,
            [venueId, membershipId, section, userId, now],
          );
        for (const section of wanted.filter((s) => !have.includes(s)))
          await c.query(
            `insert into admin_section_grants (venue_id, membership_id, section, granted_by, granted_at)
             values ($1, $2, $3, $4, $5)`,
            [venueId, membershipId, section, userId, now],
          );
        await emitEvent(c, {
          venueId,
          type: "membership.changed",
          entityId: membershipId,
          entityVersion: 0,
        });
        return liveGrants(c, venueId, membershipId);
      });
      options.gate.forget(venueId);
      return { membership_id: membershipId, sections };
    },
  );
}
