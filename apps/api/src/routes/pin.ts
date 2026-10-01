import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import {
  clearDevicePinFailures,
  clearPinLockout,
  devicePinState,
  endSessionsOnDevice,
  nameTiles,
  openSession,
  pinLockout,
  pinMembership,
  recordDevicePinFailure,
  recordPinFailure,
  verifyPin,
  withVenue,
  type PinMembership,
} from "@west4/db";
import { Temporal, type Clock } from "@west4/shared";
import type { AuthConfig } from "../config.js";
import { SESSION_MAX_HOURS, setSessionCookie } from "../auth/session-auth.js";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { enqueuePush } from "../push/send-push.js";

/**
 * Name and PIN on shared screens and phones (M1-24, spec 02 · PINs). The
 * request is signed by the device: a shared screen names the membership from
 * its tile, a person's own phone names nobody because the phone is theirs.
 * Every wrong try counts against that person on that device (the lockout
 * ladder) and against the device across any names (ten in a row pause PIN
 * sign-in there, and every manager's phone hears about it). A right PIN opens
 * a 12-hour session with assurance "pin": it never opens Admin.
 */
const pinBody = z
  .object({
    membership_id: z.string().uuid().optional(),
    pin: z.string().regex(/^\d{4,6}$/),
    client: z.enum(["shared", "phone"]),
  })
  .strict();

export interface PinRoutesOptions {
  readonly pool: pg.Pool;
  readonly clock: Clock;
  readonly config: AuthConfig;
}

const signInFailed = () => new ApiError("unauthorized", "we couldn't sign you in");

export function pinRoutes(app: FastifyInstance, options: PinRoutesOptions): void {
  const { pool, clock, config } = options;
  const now = () => clock.now();

  /** The tiles a shared screen shows: names and roles only. */
  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/team/tiles",
    { config: route({ principals: ["shared_device", "owner_manager"], module: "core" }) },
    async (request) => {
      const tiles = await request.inVenue((c) => nameTiles(c, request.venueId!));
      return {
        tiles: tiles.map((t) => ({
          membership_id: t.membershipId,
          name: t.name,
          role: t.role,
          has_pin: t.hasPin,
        })),
      };
    },
  );

  /**
   * One PIN try for a person on a device, with the ladder and the device
   * pause. Shared by sign-in and by the "ask for the PIN again" check.
   */
  async function tryPin(
    request: FastifyRequest,
    args: { venueId: string; deviceId: string; member: PinMembership },
  ): Promise<void> {
    const at = now().toString();
    const body = request.body as { pin: string };
    const outcome = await withVenue(
      pool,
      { venueId: args.venueId, userId: args.member.userId, requestId: request.requestId },
      async (c) => {
        const lock = await pinLockout(c, args.venueId, args.member.membershipId, args.deviceId);
        if (lock.lockedUntil && lock.lockedUntil > at)
          return { kind: "locked" as const, until: lock.lockedUntil };
        const ok = await verifyPin(
          config.secretKey,
          args.member.pinVerifier,
          args.venueId,
          args.member.membershipId,
          body.pin,
        );
        if (ok) {
          await clearPinLockout(c, args.venueId, args.member.membershipId, args.deviceId);
          await clearDevicePinFailures(c, args.venueId, args.deviceId);
          return { kind: "ok" as const };
        }
        await recordPinFailure(c, {
          venueId: args.venueId,
          membershipId: args.member.membershipId,
          deviceId: args.deviceId,
          now: at,
        });
        const device = await recordDevicePinFailure(c, args.venueId, args.deviceId, at);
        if (device.justPaused) {
          const state = await devicePinState(c, args.venueId, args.deviceId);
          // Until M2-15 names the manager on duty, every manager's phone gets it.
          await enqueuePush(c, {
            venueId: args.venueId,
            audience: { kind: "role", role: "manager" },
            message: {
              key: "push.pinPaused.body",
              params: { device: state?.name ?? "" },
              tag: "pin-paused",
            },
            runAt: now(),
          });
        }
        return { kind: "wrong" as const };
      },
    );
    if (outcome.kind === "locked") {
      const seconds = Math.max(
        1,
        Math.ceil(
          Temporal.Instant.from(at).until(Temporal.Instant.from(outcome.until)).total("seconds"),
        ),
      );
      throw new ApiError("rate_limited", `locked for ${seconds} seconds`);
    }
    if (outcome.kind === "wrong") throw signInFailed();
  }

  app.post<{ Body: unknown }>(
    "/v1/auth/pin",
    {
      config: route({
        principals: ["public"],
        module: "core",
        idempotency: "none",
        tokenRoute: true,
        rateLimit: { max: 60, windowMs: 60_000 },
      }),
    },
    async (request, reply) => {
      const parsed = pinBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError("invalid_request", "send { membership_id?, pin, client }");
      const device = request.signedDevice;
      if (!device) throw new ApiError("forbidden", "sign in from a paired device");
      const body = parsed.data;
      const venueId = device.venueId;
      const { state, member } = await withVenue(
        pool,
        { venueId, requestId: request.requestId },
        async (c) => {
          const state = await devicePinState(c, venueId, device.deviceId);
          if (!state) throw new ApiError("forbidden", "this device was revoked");
          const own = state.kind === "staff_phone";
          if (own !== (body.client === "phone"))
            throw new ApiError(
              "invalid_request",
              own ? "a phone signs in as its owner" : "a shared screen names the tile",
            );
          const member = own
            ? state.userId
              ? await pinMembership(c, venueId, { userId: state.userId })
              : null
            : body.membership_id
              ? await pinMembership(c, venueId, { membershipId: body.membership_id })
              : null;
          return { state, member };
        },
      );
      if (state.pausedAt)
        throw new ApiError(
          "forbidden",
          "PIN sign-in is paused on this device · a manager pairs it again",
        );
      if (!member) throw signInFailed();
      await tryPin(request, { venueId, deviceId: device.deviceId, member });

      const startedAt = now();
      const expiresAt = startedAt.add({ hours: SESSION_MAX_HOURS });
      const opened = await withVenue(
        pool,
        { venueId, userId: member.userId, requestId: request.requestId },
        async (c) => {
          // Another person taking over a shared screen ends the session before theirs.
          if (body.client === "shared")
            await endSessionsOnDevice(c, {
              deviceId: device.deviceId,
              at: startedAt.toString(),
              reason: "replaced",
            });
          return openSession(c, {
            userId: member.userId,
            principal:
              member.role === "owner" || member.role === "manager" ? "owner_manager" : "staff",
            assurance: "pin",
            client: body.client,
            membershipId: member.membershipId,
            deviceId: device.deviceId,
            startedAt: startedAt.toString(),
            expiresAt: expiresAt.toString(),
          });
        },
      );
      const answer: Record<string, unknown> = {
        session: { id: opened.id, assurance: "pin", expires_at: expiresAt.toString() },
        user: { id: member.userId, name: member.name },
        membership: {
          id: member.membershipId,
          venue_id: venueId,
          role: member.role,
          locale: member.locale,
        },
      };
      if (body.client === "phone") setSessionCookie(reply, config, opened.token);
      else answer["token"] = opened.token;
      return reply.code(200).send(answer);
    },
  );

  /**
   * Ask for the PIN again (refunds, cash counts and no-sale): the signed-in
   * person's own PIN, on the device their session was opened on, with the
   * same ladder. Later routes call `request.server.checkPinAgain(request, pin)`.
   */
  app.decorate("checkPinAgain", async (request: FastifyRequest, pin: string): Promise<void> => {
    const p = request.principal;
    const session = request.session;
    if (p.kind !== "user" || !session) throw new ApiError("forbidden", "sign in first");
    if (!session.membershipId || !session.deviceId)
      throw new ApiError("forbidden", "this check needs a PIN or badge session on a device");
    const membership = p.memberships.find((m) => m.membershipId === session.membershipId);
    if (!membership) throw new ApiError("forbidden", "sign in first");
    const member = await withVenue(
      pool,
      { venueId: membership.venueId, userId: p.userId, requestId: request.requestId },
      (c) => pinMembership(c, membership.venueId, { membershipId: session.membershipId! }),
    );
    if (!member) throw signInFailed();
    const shaped = Object.assign(Object.create(Object.getPrototypeOf(request) as object), request, {
      body: { pin },
    }) as FastifyRequest;
    await tryPin(shaped, { venueId: membership.venueId, deviceId: session.deviceId, member });
  });
}

declare module "fastify" {
  interface FastifyInstance {
    /** Verify the signed-in person's PIN again on their session's device (M1-24); throws when it fails. */
    checkPinAgain: (request: FastifyRequest, pin: string) => Promise<void>;
  }
}
