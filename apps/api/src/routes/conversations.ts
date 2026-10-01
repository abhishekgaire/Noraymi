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
import { optOut, runningLateReply, sendReply, sendTemplateIn } from "../texts/inbox.js";
import { queueText } from "../texts/queue.js";
import type { VenueTextSettings } from "../texts/venue.js";

/**
 * The two-way inbox (M2-22; spec 08 · Messages):
 *   GET  /v1/venues/{v}/conversations                         the threads, unread first
 *   GET  /v1/venues/{v}/conversations/{conversationId}        one thread; reading it marks it read
 *   POST /v1/venues/{v}/conversations/{conversationId}/messages
 *        { body } a free-text reply, or { template_key, params } a template text
 *   POST /v1/venues/{v}/conversations/{conversationId}/running-late   { until? } Reply "no problem"
 *   POST /v1/venues/{v}/messages/{messageId}/opt-out           staff mark a guest's text as an opt-out (M2-23)
 *   POST /v1/venues/{v}/sessions/{sessionId}/wrap-up-text      the board's [Text Rob & Kim: please wrap up] (M2-24)
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

  app.post<{ Params: { venueId: string; messageId: string } }>(
    "/v1/venues/:venueId/messages/:messageId/opt-out",
    { config: write },
    async (request) => {
      who(request);
      const venueId = request.venueId!;
      return request.inVenue(async (c) => {
        const message = (
          await c.query<{ conversation_id: string; direction: string; body: string }>(
            "select conversation_id, direction, body from messages where venue_id = $1 and id = $2",
            [venueId, request.params.messageId],
          )
        ).rows[0];
        if (!message) throw new ApiError("not_found", "no such message");
        if (message.direction !== "inbound")
          throw new ApiError("invalid_request", "only a guest's text can be an opt-out");
        const conversation = (await conversationById(c, venueId, message.conversation_id))!;
        const recorded = await optOut(
          c,
          venueId,
          {
            phone: conversation.phone_e164,
            guestId: conversation.guest_id,
            conversationId: conversation.id,
            via: "staff",
            source: message.body.slice(0, 100),
            now: options.clock.now(),
          },
          options.texts,
        );
        return { opted_out: true, already: !recorded };
      });
    },
  );

  app.post<{ Params: { venueId: string; sessionId: string } }>(
    "/v1/venues/:venueId/sessions/:sessionId/wrap-up-text",
    { config: write },
    async (request, reply) => {
      const userId = who(request);
      const venueId = request.venueId!;
      const result = await request.inVenue(async (c) => {
        const s = (
          await c.query<{
            room_name: string;
            guest_id: string | null;
            phone: string | null;
            ended_at: string | null;
          }>(
            `select r.name as room_name, g.id as guest_id, g.phone_e164 as phone, s.ended_at::text
               from room_sessions s
               join rooms r on r.venue_id = s.venue_id and r.id = s.room_id
               left join bookings b on b.venue_id = s.venue_id and b.id = s.booking_id
               left join guests g on g.venue_id = b.venue_id and g.id = b.guest_id
              where s.venue_id = $1 and s.id = $2`,
            [venueId, request.params.sessionId],
          )
        ).rows[0];
        if (!s) throw new ApiError("not_found", "no such session");
        if (s.ended_at) throw new ApiError("invalid_request", "the session has ended");
        if (!s.phone)
          throw new ApiError("invalid_request", "this party left no number", {
            details: { reason: "no_phone" },
          });
        return queueText(
          c,
          venueId,
          {
            templateKey: "please_wrap_up",
            to: s.phone,
            params: { room: s.room_name },
            guestId: s.guest_id,
            context: { kind: "session", id: request.params.sessionId },
            sentBy: userId,
            now: options.clock.now(),
          },
          options.texts,
        );
      });
      return reply.code(201).send({ message_id: result.messageId });
    },
  );
}
