import { openWhileReadOnly } from "../http/plan-gate.js";
import { barConnected, isBarComputer } from "../rooms/bar-presence.js";
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
import { micCommandFor, signedMicCommand, type MicSigner } from "../devices/mic-outlet.js";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { loadTrustedProxyHops, publicIpOf } from "../router/ip-owner.js";

export interface DevicesOptions {
  /** The venue's clock: what last_seen_at is stamped with. */
  readonly clock: Clock;
  /** The server's real clock, which the device's own reading is compared to. Tests may pin it. */
  readonly realNow?: () => number;
  /** Signs the mic power trial's commands (M8-23); without it, a mic outlet gets no command. */
  readonly micSigner?: MicSigner;
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
    /** The drawer a shared screen rings cash into (M4-13). */
    cash_drawer_id: z.string().uuid().nullable().optional(),
    /** Training mode for this device, such as a new hire's phone (M7-03): everything rung on it is practice. */
    training: z.boolean().optional(),
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
  const proxyHops = loadTrustedProxyHops();
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
      // The screen needs to know what it became and whose clock it runs on (M1-26).
      const about = await withVenue(app.db.pool, { venueId: claimed.venueId }, async (c) => {
        const d = await c.query<{ kind: string; name: string }>(
          "select kind, name from devices where venue_id = $1 and id = $2",
          [claimed.venueId, claimed.deviceId],
        );
        const v = await c.query<{ name: string; time_zone: string; day_cutover: string }>(
          "select name, time_zone, to_char(day_cutover, 'HH24:MI') as day_cutover from venues where id = $1",
          [claimed.venueId],
        );
        return { device: d.rows[0]!, venue: v.rows[0]! };
      });
      return reply.code(201).send({
        device_id: claimed.deviceId,
        venue_id: claimed.venueId,
        kind: about.device.kind,
        name: about.device.name,
        venue: { id: claimed.venueId, ...about.venue },
      });
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
        async (c) => {
          const bar = await isBarComputer(c, device.venueId, device.deviceId);
          // The router's fallback (M8-02): the bar computer's heartbeat carries the
          // venue's public IP, the address it reached us from.
          const network = bar
            ? {
                ...(parsed.data.network ?? {}),
                public_ip: publicIpOf(request.ip, request.headers["x-forwarded-for"], proxyHops),
              }
            : (parsed.data.network ?? null);
          const r = await recordHeartbeat(c, {
            venueId: device.venueId,
            deviceId: device.deviceId,
            now: options.clock.now(),
            appVersion: parsed.data.app_version ?? null,
            network,
            clockSkewMs,
            attached: parsed.data.attached ?? [],
          });
          // A bar computer heard from again clears "no bar device connected" (M3-17).
          if (bar) await barConnected(c, device.venueId);
          return r;
        },
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

  // The mic power trial (M8-23): only a signed mic_outlet asks, and it gets a
  // short-lived command signed with our key. It switches only the mic
  // receiver's outlet; nothing on our side can switch the song player.
  const micRoute = route({
    principals: ["public"],
    module: "core",
    idempotency: "none",
    rateLimit: { max: 120, windowMs: 60_000 },
  });
  const micDevice = (request: {
    signedDevice?: { deviceId: string; venueId: string; kind: string } | undefined;
  }) => {
    const device = request.signedDevice;
    if (!device || device.kind !== "mic_outlet")
      throw new ApiError("forbidden", "only a paired mic outlet asks for its command");
    if (!options.micSigner) throw new ApiError("not_found", "mic commands aren't set up here");
    return { device, signer: options.micSigner };
  };
  app.get("/v1/devices/mic-outlet/key", { config: micRoute }, async (request) => {
    const { signer } = micDevice(request);
    return { algorithm: "Ed25519", public_key: signer.publicKeyPem };
  });
  app.post("/v1/devices/mic-outlet/command", { config: micRoute }, async (request) => {
    const { device, signer } = micDevice(request);
    const now = options.clock.now();
    const answer = await withVenue(
      app.db.pool,
      { venueId: device.venueId, requestId: request.requestId },
      (c) => micCommandFor(c, device.venueId, device.deviceId, now),
    );
    const command = signedMicCommand(signer, device.deviceId, answer.state, now);
    return {
      device_id: command.deviceId,
      state: command.state,
      issued_at_ms: command.issuedAtMs,
      ttl_ms: command.ttlMs,
      signature: command.signature,
      reason: answer.reason,
    };
  });

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
      if (!parsed.success)
        throw new ApiError(
          "invalid_request",
          "send { name?, room_id?, cash_drawer_id?, training? }",
        );
      const updated = await request.inVenue(async (c) => {
        const row = await updateDevice(c, request.venueId!, request.params.d, {
          name: parsed.data.name,
          roomId: parsed.data.room_id,
          training: parsed.data.training,
        });
        // Its screens show or hide the training band at once (M7-03).
        if (row && parsed.data.training !== undefined)
          await emitEvent(c, {
            venueId: request.venueId!,
            type: "device.updated",
            entityId: row.id,
            entityVersion: 0,
          });
        if (row && parsed.data.cash_drawer_id !== undefined) {
          if (parsed.data.cash_drawer_id) {
            const drawer = await c.query(
              "select 1 from cash_drawers where venue_id = $1 and id = $2",
              [request.venueId, parsed.data.cash_drawer_id],
            );
            if (drawer.rowCount === 0) throw new ApiError("not_found", "no such drawer");
          }
          await c.query("update devices set cash_drawer_id = $3 where venue_id = $1 and id = $2", [
            request.venueId,
            request.params.d,
            parsed.data.cash_drawer_id,
          ]);
        }
        return row;
      });
      if (!updated) throw new ApiError("not_found", "no such device, or it was revoked");
      return updated;
    },
  );

  app.post<{ Params: VenueParams & { d: string } }>(
    "/v1/venues/:venueId/devices/:d/revoke",
    { config: openWhileReadOnly(admin) },
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

/**
 * Peripherals a host computer can see (M1-30): a USB NFC reader (and later
 * a printer) becomes a device of its own kind, known by its serial on that
 * host, so the host's heartbeats can list it as attached.
 */
export function attachedRoutes(app: FastifyInstance): void {
  const body = z
    .object({
      kind: z.enum(["nfc_reader", "printer"]),
      name: z.string().trim().min(1).max(80),
      serial: z.string().trim().min(1).max(120),
    })
    .strict();
  app.post<{ Params: { venueId: string }; Body: unknown }>(
    "/v1/venues/:venueId/devices/attached",
    {
      config: route({ principals: ["shared_device"], module: "core", idempotency: "none" }),
    },
    async (request, reply) => {
      const host = request.signedDevice;
      if (!host || host.venueId !== request.venueId)
        throw new ApiError("forbidden", "a host reports its own peripherals");
      const parsed = body.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { kind, name, serial }");
      const venueId = request.venueId!;
      const device = await request.inVenue(async (c) => {
        const found = await c.query<{ id: string }>(
          `select id from devices where venue_id = $1 and kind = $2 and revoked_at is null
             and host_device_id = $3 and serial = $4`,
          [venueId, parsed.data.kind, host.deviceId, parsed.data.serial],
        );
        if (found.rows[0]) return { id: found.rows[0].id, created: false };
        // A USB printer prints its host's station's tickets (M3-14): the bar's on the bar computer.
        const usb = parsed.data.kind === "printer";
        const made = await c.query<{ id: string }>(
          `insert into devices (venue_id, kind, name, host_device_id, serial, station, protocol)
           values ($1, $2, $3, $4, $5, $6, $7) returning id`,
          [
            venueId,
            parsed.data.kind,
            parsed.data.name,
            host.deviceId,
            parsed.data.serial,
            usb ? (host.kind === "front_desk" ? "front_desk" : "bar") : null,
            usb ? "usb" : null,
          ],
        );
        return { id: made.rows[0]!.id, created: true };
      });
      return reply
        .code(device.created ? 201 : 200)
        .send({ device_id: device.id, kind: parsed.data.kind });
    },
  );
}
