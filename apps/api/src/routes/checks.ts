import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { checkView } from "../rooms/checks.js";
import { addDamageFee } from "../rooms/damage.js";
import { fixLine } from "../rooms/fix.js";

/** M2 adds damage lines only; items come with ordering in M3. */
const lineBody = z
  .object({
    kind: z.literal("damage"),
    file_id: z.string().uuid(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

/**
 * `GET /v1/venues/{v}/checks/{c}` (M2-08; spec 08 · Checks): the number
 * (#1042), the lines and the tab so far. Tax, gratuity, totals and revisions
 * come with finalize in M4. `POST /checks/{c}/lines` adds the damage fee (M2-21):
 * only with a photo and a reason.
 */
export function checksRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  app.get<{ Params: { venueId: string; checkId: string } }>(
    "/v1/venues/:venueId/checks/:checkId",
    { config: route({ principals: ["owner_manager", "staff", "shared_device"], module: "core" }) },
    async (request) =>
      request.inVenue((c) =>
        checkView(c, request.venueId!, request.params.checkId, options.clock.now()),
      ),
  );

  app.post<{ Params: { venueId: string; checkId: string }; Body: unknown }>(
    "/v1/venues/:venueId/checks/:checkId/lines",
    {
      config: route({
        principals: ["owner_manager", "staff"],
        module: "core",
        action: "guests.checkin",
        idempotency: "optional",
      }),
    },
    async (request, reply) => {
      const parsed = lineBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError(
          "invalid_request",
          "a damage fee needs { kind: 'damage', file_id, reason }: a photo and a reason",
        );
      const p = request.principal;
      if (p.kind !== "user") throw new ApiError("forbidden", "this is a person's work");
      const venueId = request.venueId!;
      const now = options.clock.now();
      const view = await request.inVenue(async (c) => {
        const lineId = await addDamageFee(c, venueId, request.params.checkId, {
          fileId: parsed.data.file_id,
          reason: parsed.data.reason,
          userId: p.userId,
          now,
        });
        return { line_id: lineId, ...(await checkView(c, venueId, request.params.checkId, now)) };
      });
      return reply.code(201).send(view);
    },
  );

  // The fix panel (M3-19): comp or void a sent line, within the reason-only limit or through approval.
  const fixBody = z
    .object({
      reason: z.string().trim().min(1).max(300),
      made: z.boolean(),
      qty: z.number().int().min(1).max(100).optional(),
    })
    .strict();
  for (const kind of ["comp", "void"] as const) {
    app.post<{ Params: { venueId: string; checkId: string; lineId: string }; Body: unknown }>(
      `/v1/venues/:venueId/checks/:checkId/lines/:lineId/${kind}`,
      {
        config: route({
          principals: ["owner_manager", "staff"],
          module: "core",
          action: "comps.reasonOnly",
          idempotency: "optional",
        }),
      },
      async (request, reply) => {
        const parsed = fixBody.safeParse(request.body);
        if (!parsed.success)
          throw new ApiError("invalid_request", `a ${kind} needs { reason, made }`);
        const p = request.principal;
        if (p.kind !== "user") throw new ApiError("forbidden", "this is a person's work");
        const lineId = Number(request.params.lineId);
        if (
          !Number.isSafeInteger(lineId) ||
          lineId <= 0 ||
          !z.string().uuid().safeParse(request.params.checkId).success
        )
          throw new ApiError("not_found", "no such line on this check");
        const answer = await request.inVenue((c) =>
          fixLine(c, request.venueId!, {
            checkId: request.params.checkId,
            lineId,
            kind,
            made: parsed.data.made,
            qty: parsed.data.qty,
            reason: parsed.data.reason,
            userId: p.userId,
            deviceId: request.signedDevice?.deviceId ?? request.session?.deviceId ?? null,
            now: options.clock.now(),
          }),
        );
        return reply.code(answer.status === "added" ? 201 : 202).send(answer);
      },
    );
  }
}
