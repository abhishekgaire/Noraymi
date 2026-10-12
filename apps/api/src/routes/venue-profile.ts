import type { FastifyInstance, FastifyRequest } from "fastify";
import { emitEvent, type Queryable } from "@west4/db";
import { addressOutsideNewYork, venueProfileSchema, type VenueAddress } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";

/**
 * Admin → Venue and Set up your venue's step 1 (O-03; spec 17 · Step details 1):
 *   GET /v1/venues/{v}/profile   the name guests see, the legal name and the address
 *   PUT /v1/venues/{v}/profile   the owner changes them
 * The address confirms New York's rule pack and time zone and never changes them: one outside New
 * York City is refused with "contact us". The legal name is the organization's (Stripe's form and
 * the texts registration start from it). The guest phone and the booking inbox are the `phone` and
 * `contacts` settings keys, saved through the settings routes. No EIN is asked or kept.
 */
interface VenueParams {
  venueId: string;
}

export interface ProfileOut {
  readonly name: string;
  readonly legal_name: string;
  readonly address: VenueAddress | null;
  readonly time_zone: string;
  readonly rule_pack_id: string | null;
}

export async function venueProfile(c: Queryable, venueId: string): Promise<ProfileOut> {
  const r = await c.query<ProfileOut>(
    `select v.name, o.legal_name, v.address, v.time_zone, v.rule_pack_id
       from venues v join organizations o on o.id = v.org_id where v.id = $1`,
    [venueId],
  );
  if (!r.rows[0]) throw new ApiError("not_found", "no such venue");
  return r.rows[0];
}

function ownerHere(request: FastifyRequest): string {
  const venueId = request.venueId!;
  const p = request.principal;
  const here = p.kind === "user" ? p.memberships.find((m) => m.venueId === venueId) : undefined;
  if (here?.role !== "owner") throw new ApiError("forbidden", "Admin → Venue is the owner's");
  return venueId;
}

export function venueProfileRoutes(app: FastifyInstance): void {
  const read = route({
    principals: ["owner_manager"],
    module: "core",
    action: "admin.access",
    assurance: "passkey",
  });
  const write = route({
    principals: ["owner_manager"],
    module: "core",
    action: "admin.access",
    assurance: "passkey",
    idempotency: "optional",
  });

  app.get<{ Params: VenueParams }>(
    "/v1/venues/:venueId/profile",
    { config: read },
    async (request) => {
      const venueId = ownerHere(request);
      return { profile: await request.inVenue((c) => venueProfile(c, venueId)) };
    },
  );

  app.put<{ Params: VenueParams; Body: unknown }>(
    "/v1/venues/:venueId/profile",
    { config: write },
    async (request) => {
      const venueId = ownerHere(request);
      const parsed = venueProfileSchema.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError("invalid_request", "send { name, legal_name, address }", {
          details: {
            reasons: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
          },
        });
      const b = parsed.data;
      if (b.address && addressOutsideNewYork(b.address))
        throw new ApiError("invalid_request", "This address is outside New York · contact us", {
          details: { reason: "outside_new_york", field: "address" },
        });
      return {
        profile: await request.inVenue(async (c) => {
          await c.query("update venues set name = $2, address = $3 where id = $1", [
            venueId,
            b.name,
            b.address ? JSON.stringify(b.address) : null,
          ]);
          await c.query(
            "update organizations set legal_name = $2 where id = (select org_id from venues where id = $1)",
            [venueId, b.legal_name],
          );
          await emitEvent(c, {
            venueId,
            type: "settings.changed",
            entityId: "profile",
            entityVersion: 0,
          });
          return venueProfile(c, venueId);
        }),
      };
    },
  );
}
