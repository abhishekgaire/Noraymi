import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { addScanCheck, addVisualChecks, idCounts, rulePackFor, venueModules } from "@west4/db";
import { onlyPackFields, Temporal, type Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";

/**
 * `POST /v1/venues/{v}/sessions/{s}/id-checks` (M2-12; spec 08 · Safety): a
 * visual check (who checked, when) or a scan read on the device, of which only
 * the rule pack's four fields are kept, sealed with the night's key and set to
 * be deleted after `idScan.keepDays`. Scanning needs Safety & ID records; the
 * visual count doesn't.
 */
const body = z.discriminatedUnion("method", [
  z
    .object({ method: z.literal("visual"), count: z.number().int().min(1).max(50).optional() })
    .strict(),
  z.object({ method: z.literal("scan"), fields: z.record(z.string(), z.unknown()) }).strict(),
]);

export function idCheckRoutes(
  app: FastifyInstance,
  options: { clock: Clock; wrappingKey: Buffer },
): void {
  app.post<{ Params: { venueId: string; sessionId: string }; Body: unknown }>(
    "/v1/venues/:venueId/sessions/:sessionId/id-checks",
    {
      config: route({
        principals: ["owner_manager", "staff"],
        module: "core",
        action: "guests.checkin",
        idempotency: "optional",
      }),
    },
    async (request, reply) => {
      const parsed = body.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError(
          "invalid_request",
          "send { method: 'visual' } or { method: 'scan', fields }",
        );
      const p = request.principal;
      if (p.kind !== "user") throw new ApiError("forbidden", "an ID check is a person's work");
      const venueId = request.venueId!;
      const now = options.clock.now();
      // The reply goes out after the transaction commits, never from inside it.
      const result = await request.inVenue(async (c) => {
        const session = (
          await c.query<{
            id: string;
            party_size: number;
            business_date: string;
            ended_at: string | null;
            rule_pack_id: string | null;
          }>(
            `select s.id, s.party_size, s.business_date::text, s.ended_at, v.rule_pack_id
               from room_sessions s join venues v on v.id = s.venue_id where s.venue_id = $1 and s.id = $2`,
            [venueId, request.params.sessionId],
          )
        ).rows[0];
        if (!session) throw new ApiError("not_found", "no such session");
        if (parsed.data.method === "visual") {
          await addVisualChecks(c, venueId, {
            sessionId: session.id,
            count: parsed.data.count ?? 1,
            checkedBy: p.userId,
            at: now.toString(),
          });
          return {
            method: "visual",
            ids_checked: (await idCounts(c, venueId, [session.id])).get(session.id) ?? 0,
          };
        }
        const safety = (await venueModules(c, venueId)).find((m) => m.module_id === "safety");
        if (safety?.state === "off")
          throw new ApiError("module_off", "ID scanning is off with Safety & ID records off");
        const pack = await rulePackFor(
          c,
          session.rule_pack_id ?? "us-ny-new-york-county",
          Temporal.PlainDate.from(session.business_date),
        );
        if (!pack) throw new ApiError("internal", "no usable rule pack");
        const fields = onlyPackFields(parsed.data.fields, pack.pack.idScan.fields);
        if (Object.keys(fields).length !== pack.pack.idScan.fields.length)
          throw new ApiError(
            "invalid_request",
            `a scan carries ${pack.pack.idScan.fields.join(", ")}`,
          );
        const scan = await addScanCheck(c, venueId, {
          sessionId: session.id,
          fields,
          checkedBy: p.userId,
          at: now.toString(),
          businessDate: session.business_date,
          keepDays: pack.pack.idScan.keepDays,
          wrappingKey: options.wrappingKey,
        });
        return {
          method: "scan",
          delete_after: scan.deleteAfter,
          ids_checked: (await idCounts(c, venueId, [session.id])).get(session.id) ?? 0,
        };
      });
      return reply.code(201).send(result);
    },
  );
}
