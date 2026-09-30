import type { FastifyInstance } from "fastify";
import {
  claimDevice,
  createPairingCode,
  deviceKinds,
  emitEvent,
  listDevices,
  revokeDevice,
  updateDevice,
  type DeviceKind,
} from "@west4/db";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";

interface VenueParams {
  venueId: string;
}

const pairBody = z
  .object({
    kind: z.enum(deviceKinds as [DeviceKind, ...DeviceKind[]]),
    name: z.string().min(1).max(80),
    room_id: z.string().uuid().nullable().optional(),
  })
  .strict();
const claimBody = z
  .object({ code: z.string().min(4).max(32), public_key: z.record(z.string(), z.unknown()) })
  .strict();
const patchBody = z
  .object({
    name: z.string().min(1).max(80).optional(),
    room_id: z.string().uuid().nullable().optional(),
  })
  .strict();

/**
 * Devices (spec 08 · Sign-in, team and devices; M1-15):
 *   POST  /v1/venues/{v}/devices/pair        a manager makes a one-time code (Admin → Printers & devices)
 *   POST  /v1/devices/claim                  the device trades the code and its public key for its id
 *   GET   /v1/venues/{v}/devices             the venue's devices
 *   PATCH /v1/venues/{v}/devices/{d}         the name, and a tablet's room
 *   POST  /v1/venues/{v}/devices/{d}/revoke  ends the device's sessions and closes its sockets at once
 */
export function devicesRoutes(app: FastifyInstance): void {
  const admin = route({
    principals: ["owner_manager"],
    module: "core",
    action: "admin.access",
    idempotency: "optional",
  });

  app.post<{ Params: VenueParams; Body: unknown }>(
    "/v1/venues/:venueId/devices/pair",
    { config: admin },
    async (request, reply) => {
      const parsed = pairBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError(
          "invalid_request",
          parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        );
      const made = await request.inVenue((c) =>
        createPairingCode(c, {
          venueId: request.venueId!,
          kind: parsed.data.kind,
          name: parsed.data.name,
          roomId: parsed.data.room_id ?? null,
          createdBy: request.principal.kind === "user" ? request.principal.userId : undefined,
        }),
      );
      return reply.code(201).send({ code: made.code, expires_at: made.expiresAt });
    },
  );

  app.post<{ Body: unknown }>(
    "/v1/devices/claim",
    {
      config: route({
        principals: ["public"],
        module: "core",
        idempotency: "none",
        rateLimit: { max: 20, windowMs: 60_000 },
      }),
    },
    async (request, reply) => {
      const parsed = claimBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { code, public_key }");
      const claimed = await claimDevice(app.db.pool, parsed.data.code, parsed.data.public_key);
      if (!claimed)
        throw new ApiError(
          "forbidden",
          "that code isn't valid: it was used, it expired, or it never existed",
        );
      return reply.code(201).send({ device_id: claimed.deviceId, venue_id: claimed.venueId });
    },
  );

  app.get<{ Params: VenueParams }>(
    "/v1/venues/:venueId/devices",
    { config: route({ principals: ["owner_manager"], module: "core", action: "admin.access" }) },
    async (request) => ({
      devices: await request.inVenue((c) => listDevices(c, request.venueId!)),
    }),
  );

  app.patch<{ Params: VenueParams & { d: string }; Body: unknown }>(
    "/v1/venues/:venueId/devices/:d",
    { config: admin },
    async (request) => {
      const parsed = patchBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { name?, room_id? }");
      const updated = await request.inVenue((c) =>
        updateDevice(c, request.venueId!, request.params.d, {
          name: parsed.data.name,
          roomId: parsed.data.room_id,
        }),
      );
      if (!updated) throw new ApiError("not_found", "no such device, or it was revoked");
      return updated;
    },
  );

  app.post<{ Params: VenueParams & { d: string } }>(
    "/v1/venues/:venueId/devices/:d/revoke",
    { config: admin },
    async (request) => {
      const venueId = request.venueId!;
      const revoked = await request.inVenue(async (c) => {
        const row = await revokeDevice(c, venueId, request.params.d);
        if (row)
          await emitEvent(c, {
            venueId,
            type: "device.offline",
            entityId: row.id,
            entityVersion: 0,
          });
        return row;
      });
      if (!revoked) throw new ApiError("not_found", "no such device");
      app.events.closeSocketsFor(request.params.d);
      return revoked;
    },
  );
}
