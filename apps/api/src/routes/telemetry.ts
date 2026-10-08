import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { orderById } from "@west4/db";
import { parseTraceparent, type Clock } from "@west4/shared";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { telemetry } from "../telemetry/index.js";
import { noteAlarm } from "../telemetry/order-trace.js";
import { readStatus } from "../telemetry/status.js";

const ALARM_DEVICES = ["bar_computer", "front_desk"];

const clientReport = z
  .object({
    service: z.enum(["staff", "desktop", "guest", "console"]),
    errors: z
      .array(
        z
          .object({
            type: z.string().max(100).optional(),
            message: z.string().max(2000),
            stack: z.string().max(8000).optional(),
            page: z.string().max(200).optional(),
            traceparent: z.string().max(60).optional(),
          })
          .strict(),
      )
      .max(20),
    spans: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z0-9._ -]{1,80}$/i),
            traceparent: z.string().max(60),
            parent_span_id: z
              .string()
              .regex(/^[0-9a-f]{16}$/)
              .optional(),
            duration_ms: z.number().int().min(0).max(600_000),
            failed: z.boolean().optional(),
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict();

/**
 * Watching production (M8-16):
 *   POST /v1/venues/:venueId/orders/:orderId/rang   a bar or front-desk computer's alarm rang for an order
 *   POST /v1/public/telemetry                       the screens' errors, scrubbed, to error tracking
 *   GET  /v1/public/status                                 the public status page's parts
 */
export function telemetryRoutes(
  app: FastifyInstance,
  options: { readonly pool: pg.Pool; readonly clock: Clock },
): void {
  app.post<{ Params: { venueId: string; orderId: string } }>(
    "/v1/venues/:venueId/orders/:orderId/rang",
    { config: route({ principals: ["shared_device"], module: "core", idempotency: "none" }) },
    async (request, reply) => {
      const device = request.signedDevice;
      if (!device || device.venueId !== request.venueId)
        throw new ApiError("forbidden", "a computer reports its own alarm");
      if (!ALARM_DEVICES.includes(device.kind))
        throw new ApiError("forbidden", "only the bar and front-desk computers ring for orders");
      if (!z.uuid().safeParse(request.params.orderId).success)
        throw new ApiError("not_found", "no such order");
      await request.inVenue(async (c) => {
        const order = await orderById(c, request.venueId!, request.params.orderId);
        if (!order) throw new ApiError("not_found", "no such order");
        await noteAlarm(
          c,
          request.venueId!,
          order.id,
          device.deviceId,
          options.clock.now().toString(),
        );
      });
      return reply.code(204).send();
    },
  );

  app.post<{ Body: unknown }>(
    "/v1/public/telemetry",
    {
      config: route({
        principals: ["public"],
        module: "core",
        idempotency: "none",
        rateLimit: { max: 60, windowMs: 60_000 },
      }),
    },
    async (request, reply) => {
      const parsed = clientReport.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { service, errors, spans }");
      const t = telemetry();
      for (const e of parsed.data.errors) {
        const error = new Error(e.message);
        error.name = e.type ?? "Error";
        error.stack = e.stack ?? `${error.name}: ${e.message}`;
        t.captureError(
          error,
          { "client.service": parsed.data.service, "client.page": e.page ?? null },
          parseTraceparent(e.traceparent),
        );
      }
      // The spans a screen timed itself: the room page's send opens a room order's trace.
      for (const span of parsed.data.spans ?? []) {
        const context = parseTraceparent(span.traceparent);
        if (!context) continue;
        t.recordSpan({
          context,
          parentSpanId: span.parent_span_id ?? null,
          name: span.name,
          durationMs: span.duration_ms,
          status: span.failed ? "error" : "ok",
          attributes: { "client.service": parsed.data.service },
        });
      }
      return reply.code(202).send();
    },
  );

  app.get(
    "/v1/public/status",
    { config: route({ principals: ["public"], module: "core", rateLimit: false }) },
    async (_request, reply) => {
      reply.header("cache-control", "public, max-age=15");
      return readStatus(options.pool);
    },
  );
}
