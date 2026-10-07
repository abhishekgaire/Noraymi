import type pg from "pg";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { withVenue } from "@west4/db";
import type { Clock } from "@west4/shared";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import {
  INCIDENT_KINDS,
  ackIncident,
  addIncidentNote,
  incidentYears,
  closeIncident,
  listIncidents,
  logIncident,
  openHelpAlert,
  safetyOn,
  type IncidentKind,
} from "../rooms/incidents.js";
import { currentGuest } from "./room-orders.js";

/**
 * Incidents (M8-08; spec 08 · Guest room, Safety; screens N20). All behind
 * Safety & ID records:
 *   POST /v1/public/room-session/help               { kind }: a guest's own phone only, never a room tablet
 *   GET  /v1/venues/{v}/incidents                   the log (managers and owners only)
 *   POST /v1/venues/{v}/incidents                   { kind, room_id?, note }: a manager logs one by hand
 *   POST /v1/venues/{v}/incidents/{i}/ack           I'm on it
 *   POST /v1/venues/{v}/incidents/{i}/notes         { text }: added to the log, never edited
 *   POST /v1/venues/{v}/incidents/{i}/close
 */
const kind = z.enum(INCIDENT_KINDS as [IncidentKind, ...IncidentKind[]]);
const text = z.string().trim().min(1).max(2000);

const who = (request: FastifyRequest) => {
  const p = request.principal;
  if (p.kind !== "user") throw new ApiError("forbidden", "this is a manager's work");
  return p.userId;
};

export function incidentRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool; clock: Clock },
): void {
  app.post<{ Body: unknown }>(
    "/v1/public/room-session/help",
    {
      config: route({
        principals: ["guest_room"],
        module: "safety",
        idempotency: "none",
        tokenRoute: true,
        createsNewWork: true,
      }),
    },
    async (request, reply) => {
      const parsed = z.object({ kind }).strict().safeParse(request.body);
      if (!parsed.success)
        throw new ApiError("invalid_request", `kind is one of ${INCIDENT_KINDS.join(", ")}`);
      const me = await currentGuest(request, options.pool, options.clock);
      await withVenue(
        options.pool,
        { venueId: me.venueId, requestId: request.requestId },
        async (c) => {
          // A token route has no venue in its path, so the module gate can't see it: check here.
          if (!(await safetyOn(c, me.venueId)))
            throw new ApiError("module_off", "this part of the system is off at this venue");
          return openHelpAlert(c, me.venueId, {
            roomGuestId: me.id,
            sessionId: me.session_id,
            roomId: me.session.room_id,
            kind: parsed.data.kind,
            now: options.clock.now(),
          });
        },
      );
      // The guest's phone learns only that it was sent: no id, no names.
      return reply.code(201).send({ sent: true });
    },
  );

  const read = route({ principals: ["owner_manager"], module: "safety" });
  const write = route({ principals: ["owner_manager"], module: "safety", idempotency: "optional" });
  const create = route({
    principals: ["owner_manager"],
    module: "safety",
    idempotency: "optional",
    createsNewWork: true,
  });

  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/incidents",
    { config: read },
    async (request) =>
      request.inVenue(async (c) => ({
        incidents: await listIncidents(c, request.venueId!),
        // How long a closed one is kept, from the rule pack (3 years in New York).
        kept_years: await incidentYears(c, request.venueId!, options.clock.now()),
      })),
  );

  app.post<{ Params: { venueId: string }; Body: unknown }>(
    "/v1/venues/:venueId/incidents",
    { config: create },
    async (request, reply) => {
      const parsed = z
        .object({ kind, room_id: z.string().uuid().nullable().optional(), note: text })
        .strict()
        .safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { kind, room_id?, note }");
      const userId = who(request);
      const incident = await request.inVenue((c) =>
        logIncident(c, request.venueId!, {
          userId,
          kind: parsed.data.kind,
          roomId: parsed.data.room_id ?? null,
          note: parsed.data.note,
          now: options.clock.now(),
        }),
      );
      return reply.code(201).send({ incident });
    },
  );

  app.post<{ Params: { venueId: string; incidentId: string } }>(
    "/v1/venues/:venueId/incidents/:incidentId/ack",
    { config: write },
    async (request) => {
      const userId = who(request);
      return {
        incident: await request.inVenue((c) =>
          ackIncident(c, request.venueId!, request.params.incidentId, {
            userId,
            now: options.clock.now(),
          }),
        ),
      };
    },
  );

  app.post<{ Params: { venueId: string; incidentId: string }; Body: unknown }>(
    "/v1/venues/:venueId/incidents/:incidentId/notes",
    { config: write },
    async (request, reply) => {
      const parsed = z.object({ text }).strict().safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { text }");
      const userId = who(request);
      const incident = await request.inVenue((c) =>
        addIncidentNote(c, request.venueId!, request.params.incidentId, {
          userId,
          text: parsed.data.text,
          now: options.clock.now(),
        }),
      );
      return reply.code(201).send({ incident });
    },
  );

  app.post<{ Params: { venueId: string; incidentId: string } }>(
    "/v1/venues/:venueId/incidents/:incidentId/close",
    { config: write },
    async (request) => {
      const userId = who(request);
      return {
        incident: await request.inVenue((c) =>
          closeIncident(c, request.venueId!, request.params.incidentId, {
            userId,
            now: options.clock.now(),
          }),
        ),
      };
    },
  );
}
