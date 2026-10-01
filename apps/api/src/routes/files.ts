import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isFileKind, type Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import type { S3Settings } from "../s3.js";
import { downloadLink, newUpload } from "../files/storage.js";

/**
 * Files (M2-13; spec 08 · Files):
 *   POST /v1/venues/{v}/files      { kind, content_type, bytes } → a presigned POST and a file id
 *   GET  /v1/venues/{v}/files/{f}  a short-lived download link
 */
const body = z
  .object({
    kind: z.string(),
    content_type: z.string().min(1).max(100),
    bytes: z.number().int().min(1),
  })
  .strict();

export function filesRoutes(
  app: FastifyInstance,
  options: { clock: Clock; s3: () => S3Settings },
): void {
  const principals = ["owner_manager", "staff", "shared_device"] as const;
  app.post<{ Params: { venueId: string }; Body: unknown }>(
    "/v1/venues/:venueId/files",
    { config: route({ principals: [...principals], module: "core", idempotency: "optional" }) },
    async (request, reply) => {
      const parsed = body.safeParse(request.body);
      if (!parsed.success || !isFileKind(parsed.data.kind))
        throw new ApiError(
          "invalid_request",
          "send { kind, content_type, bytes } with a known kind",
        );
      const p = request.principal;
      const upload = await request.inVenue((c) =>
        newUpload(c, options.s3(), {
          venueId: request.venueId!,
          kind: parsed.data.kind as never,
          contentType: parsed.data.content_type,
          bytes: parsed.data.bytes,
          uploadedBy: p.kind === "user" ? p.userId : null,
          now: options.clock.now(),
        }),
      );
      return reply.code(201).send(upload);
    },
  );

  app.get<{ Params: { venueId: string; fileId: string } }>(
    "/v1/venues/:venueId/files/:fileId",
    { config: route({ principals: [...principals], module: "core" }) },
    async (request) =>
      request.inVenue((c) =>
        downloadLink(c, options.s3(), request.venueId!, request.params.fileId),
      ),
  );
}
