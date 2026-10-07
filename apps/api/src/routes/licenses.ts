import type { FastifyInstance, FastifyRequest } from "fastify";
import { Temporal, type Clock } from "@west4/shared";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import {
  LICENSE_KINDS,
  createLicense,
  listLicenses,
  updateLicense,
  type LicenseKind,
} from "../licenses/licenses.js";

/**
 * The license register (M8-09; spec 08 · Safety; screens N35). Admin →
 * Licenses: owners and managers, in a passkey session.
 *   GET   /v1/venues/{v}/licenses           the register, with days left on the venue's date
 *   POST  /v1/venues/{v}/licenses           { kind, number?, holder?, authority?, starts_on?, expires_on?, fee_cents?, conditions?, file_id? }
 *   PATCH /v1/venues/{v}/licenses/{l}       any of those but the kind; a new expiry starts the reminders over
 */
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    try {
      Temporal.PlainDate.from(v, { overflow: "reject" });
      return true;
    } catch {
      return false;
    }
  })
  .nullable()
  .optional();
const fields = {
  number: text(100),
  holder: text(200),
  authority: text(200),
  starts_on: day,
  expires_on: day,
  fee_cents: z.number().int().min(0).max(100_000_000).nullable().optional(),
  conditions: text(2000),
  file_id: z.string().uuid().nullable().optional(),
};
const createBody = z
  .object({ kind: z.enum(LICENSE_KINDS as unknown as [LicenseKind, ...LicenseKind[]]), ...fields })
  .strict();
const patchBody = z.object(fields).strict();

const userOf = (request: FastifyRequest) =>
  request.principal.kind === "user" ? request.principal.userId : null;

export function licenseRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  const read = route({ principals: ["owner_manager"], module: "core", action: "admin.access" });
  const write = route({
    principals: ["owner_manager"],
    module: "core",
    action: "admin.access",
    idempotency: "optional",
  });

  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/licenses",
    { config: read },
    async (request) =>
      request.inVenue(async (c) => ({
        licenses: await listLicenses(c, request.venueId!, options.clock.now()),
      })),
  );

  app.post<{ Params: { venueId: string }; Body: unknown }>(
    "/v1/venues/:venueId/licenses",
    { config: write },
    async (request, reply) => {
      const parsed = createBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError(
          "invalid_request",
          `send { kind, number?, holder?, authority?, starts_on?, expires_on?, fee_cents?, conditions?, file_id? } with kind one of ${LICENSE_KINDS.join(", ")}`,
        );
      const license = await request.inVenue((c) =>
        createLicense(c, request.venueId!, {
          ...parsed.data,
          userId: userOf(request),
          now: options.clock.now(),
        }),
      );
      return reply.code(201).send({ license });
    },
  );

  app.patch<{ Params: { venueId: string; licenseId: string }; Body: unknown }>(
    "/v1/venues/:venueId/licenses/:licenseId",
    { config: write },
    async (request) => {
      if (!z.string().uuid().safeParse(request.params.licenseId).success)
        throw new ApiError("not_found", "no such license");
      const parsed = patchBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError(
          "invalid_request",
          "send any of { number, holder, authority, starts_on, expires_on, fee_cents, conditions, file_id }",
        );
      return {
        license: await request.inVenue((c) =>
          updateLicense(c, request.venueId!, request.params.licenseId, {
            ...parsed.data,
            now: options.clock.now(),
          }),
        ),
      };
    },
  );
}
