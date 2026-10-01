import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  conversationById,
  conversations,
  emitEvent,
  markConversationRead,
  templates,
  threadMessages,
} from "@west4/db";
import { Temporal, type Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { runningLateReply, sendReply, sendTemplateIn } from "../texts/inbox.js";
import type { VenueTextSettings } from "../texts/venue.js";

/**
 * The two-way inbox (M2-22; spec 08 · Messages):
 *   GET  /v1/venues/{v}/conversations                         the threads, unread first
 *   GET  /v1/venues/{v}/conversations/{conversationId}        one thread; reading it marks it read
 *   POST /v1/venues/{v}/conversations/{conversationId}/messages
 *        { body } a free-text reply, or { template_key, params } a template text
 *   POST /v1/venues/{v}/conversations/{conversationId}/running-late   { until? } Reply "no problem"
 *   GET  /v1/venues/{v}/texts                                 the 14 automatic texts in Admin's order, on or off
 */
const messageBody = z.union([
  z.object({ body: z.string().trim().min(1).max(640) }).strict(),
  z
    .object({
      template_key: z.string().min(1).max(60),
      params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    })
    .strict(),
]);
const lateBody = z.object({ until: z.string().datetime({ offset: true }).optional() }).strict();

const who = (request: FastifyRequest) => {
  const p = request.principal;
  if (p.kind !== "user") throw new ApiError("forbidden", "this is a person's work");
  return p.userId;
};

export function conversationRoutes(
  app: FastifyInstance,
  options: { clock: Clock; texts: Pick<VenueTextSettings, "allowList"> },
): void {
  const read = route({
    principals: ["owner_manager", "staff"],
    module: "guest_texts",
    action: "texts.send",
  });
  const write = route({
    principals: ["owner_manager", "staff"],
    module: "guest_texts",
    action: "texts.send",
    idempotency: "optional",
  });

  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/conversations",
    { config: read },
    async (request) => {
      const list = await request.inVenue((c) => conversations(c, request.venueId!));
      return { conversations: list, unread: list.reduce((n, cv) => n + cv.unread, 0) };
    },
  );

  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/texts",
    { config: read },
    async (request) => ({
      texts: (await request.inVenue((c) => templates(c, request.venueId!))).map((x) => ({
        key: x.key,
        position: x.position,
        category: x.category,
        on: x.on,
      })),
    }),
  );

  app.get<{ Params: { venueId: string; conversationId: string } }>(
    "/v1/venues/:venueId/conversations/:conversationId",
    { config: read },
    async (request) => {
      const venueId = request.venueId!;
      return request.inVenue(async (c) => {
        const conversation = await conversationById(c, venueId, request.params.conversationId);
        if (!conversation) throw new ApiError("not_found", "no such conversation");
        if (conversation.unread > 0) {
          await markConversationRead(c, venueId, conversation.id, options.clock.now().toString());
          await emitEvent(c, {
            venueId,
            type: "message.updated",
            entityId: conversation.id,
            entityVersion: 0,
          });
        }
        return {
          conversation: { ...conversation, unread: 0 },
          messages: await threadMessages(c, venueId, conversation.id),
        };
      });
    },
  );

  app.post<{ Params: { venueId: string; conversationId: string }; Body: unknown }>(
    "/v1/venues/:venueId/conversations/:conversationId/messages",
    { config: write },
    async (request, reply) => {
      const parsed = messageBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError("invalid_request", "send { body } or { template_key, params }");
      const userId = who(request);
      const venueId = request.venueId!;
      const now = options.clock.now();
      const id = await request.inVenue((c) =>
        "body" in parsed.data
          ? sendReply(
              c,
              venueId,
              request.params.conversationId,
              { body: parsed.data.body, userId, now },
              options.texts,
            )
          : sendTemplateIn(
              c,
              venueId,
              request.params.conversationId,
              {
                templateKey: parsed.data.template_key,
                params: parsed.data.params ?? {},
                userId,
                now,
              },
              options.texts,
            ),
      );
      return reply.code(201).send({ message_id: id });
    },
  );

  app.post<{ Params: { venueId: string; conversationId: string }; Body: unknown }>(
    "/v1/venues/:venueId/conversations/:conversationId/running-late",
    { config: write },
    async (request, reply) => {
      const parsed = lateBody.safeParse(request.body ?? {});
      if (!parsed.success) throw new ApiError("invalid_request", "send { until? }");
      const userId = who(request);
      const venueId = request.venueId!;
      const result = await request.inVenue((c) =>
        runningLateReply(
          c,
          venueId,
          request.params.conversationId,
          {
            until: parsed.data.until ? Temporal.Instant.from(parsed.data.until) : null,
            userId,
            now: options.clock.now(),
          },
          options.texts,
        ),
      );
      return reply.code(201).send(result);
    },
  );
}
