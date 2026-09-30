import type { FastifyInstance } from "fastify";
import {
  claimDevice,
  createPairingCode,
  deviceKinds,
  emitEvent,
  listDevices,
  recordHeartbeat,
  revokeDevice,
  updateDevice,
  withVenue,
  type DeviceKind,
} from "@west4/db";
import { Temporal, type Clock } from "@west4/shared";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";

export interface DevicesOptions {
  /** The venue's clock: what last_seen_at is stamped with. */
  readonly clock: Clock;
  /** The server's real clock, which the device's own reading is compared to. Tests may pin it. */
  readonly realNow?: () => number;
}

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
const isInstant = (s: string): boolean => {
  try {
    Temporal.Instant.from(s);
    return true;
  } catch {
    return false;
  }
};
const heartbeatBody = z
  .object({
    app_version: z.string().max(80).nullable().optional(),
    network: z.record(z.string(), z.unknown()).nullable().optional(),
    /** The device's own clock at the moment it sent this, ISO 8601 with an offset. */
    clock: z.string().refine(isInstant, "clock must be an ISO 8601 instant"),
    /** Attached printers and NFC readers the host computer can see right now. */
    attached: z.array(z.string().uuid()).max(50).optional(),
  })
  .strict();

/**
 * Devices (spec 08 · Sign-in, team and devices; M1-15):
 *   POST  /v1/venues/{v}/devices/pair        a manager makes a one-time code (Admin → Printers & devices)
 *   POST  /v1/devices/claim                  the device trades the code and its public key for its id
 *   GET   /v1/venues/{v}/devices             the venue's devices
 *   PATCH /v1/venues/{v}/devices/{d}         the name, and a tablet's room
 *   POST  /v1/venues/{v}/devices/{d}/revoke  ends the device's sessions and closes its sockets at once
 *   POST  /v1/devices/heartbeat              every 30 seconds from every device, signed (M1-16)
 */
export function devicesRoutes(app: FastifyInstance, options: DevicesOptions): void {
  const realNow = options.realNow ?? Date.now;
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

  // The heartbeat has no venue in its path: the signature names the device, and
  // the device names its venue. Any signed device may send one, including the
  // kinds that never act as a principal (a staff phone); an unsigned request is 403.
  app.post<{ Body: unknown }>(
    "/v1/devices/heartbeat",
    {
      config: route({
        principals: ["public"],
        module: "core",
        idempotency: "none",
        rateLimit: { max: 600, windowMs: 60_000 },
      }),
    },
    async (request) => {
      const device = request.signedDevice;
      if (!device) throw new ApiError("forbidden", "a heartbeat is signed by the device");
      const parsed = heartbeatBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError(
          "invalid_request",
          parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        );
      const clockSkewMs = Temporal.Instant.from(parsed.data.clock).epochMilliseconds - realNow();
      const result = await withVenue(
        app.db.pool,
        { venueId: device.venueId, requestId: request.requestId },
        (c) =>
          recordHeartbeat(c, {
            venueId: device.venueId,
            deviceId: device.deviceId,
            now: options.clock.now(),
            appVersion: parsed.data.app_version ?? null,
            network: parsed.data.network ?? null,
            clockSkewMs,
            attached: parsed.data.attached ?? [],
          }),
      );
      return {
        device_id: device.deviceId,
        clock_skew_ms: clockSkewMs,
        clock_alert: result.clockAlert,
        back_online: result.backOnline,
        attached_ignored: result.attachedIgnored,
      };
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
