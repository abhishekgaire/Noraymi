import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createSetupRequest, listSetupRequests } from "@west4/db";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";

/**
 * Set up your venue's step 11 (O-12; spec 17 · Step details 11), all optional:
 *   GET  /v1/venues/{v}/setup/texts      the step's requests (the website and the old system's files)
 *   POST /v1/venues/{v}/setup/website    "Do you have a website and domain to move?"
 *   (the old system's export files: POST /files as import_export, then POST /setup/requests)
 * The texts part is Connect your Twilio account, the venue's own (T-01, T-02; D123), whose routes are
 * in texts-twilio.ts; Register for texts and its ISV flow are gone. Any owner or manager with Admin.
 */
const websiteBody = z
  .object({
    answer: z.enum(["yes", "no"]),
    domain: z.string().trim().min(3).max(253).nullable().optional(),
  })
  .strict();

export function setupTextsRoutes(app: FastifyInstance): void {
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
  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/setup/texts",
    { config: read },
    async (request) =>
      request.inVenue(async (c) => ({
        requests: (await listSetupRequests(c, request.venueId!)).filter(
          (r) => r.kind === "website" || r.kind === "old_system",
        ),
      })),
  );

  app.post<{ Params: { venueId: string }; Body: unknown }>(
    "/v1/venues/:venueId/setup/website",
    { config: write },
    async (request, reply) => {
      const parsed = websiteBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { answer, domain? }");
      const p = request.principal;
      if (p.kind !== "user") throw new ApiError("forbidden", "you can't call this");
      const venueId = request.venueId!;
      const made = await request.inVenue((c) =>
        createSetupRequest(c, venueId, {
          kind: "website",
          answer: parsed.data.answer,
          fileId: null,
          note: parsed.data.answer === "yes" ? (parsed.data.domain ?? null) : null,
          userId: p.userId,
        }),
      );
      return reply.code(201).send(made);
    },
  );
}
