import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createStaffPhone, savePushSubscription, type Queryable } from "@west4/db";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { enqueuePush } from "../push/send-push.js";
import type { PushSettings } from "../push/settings.js";

/**
 * Staff phones and web push (M1-22, spec 09 · Staff phones). A signed-in
 * person's own phone becomes their staff_phone device; the phone then signs a
 * request to save its push subscription, so a subscription always belongs to
 * a paired phone and dies with it.
 */
type VenueParams = { venueId: string };

const staffPhoneBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    public_key: z.record(z.string(), z.unknown()),
  })
  .strict();

const subscriptionBody = z
  .object({
    endpoint: z.string().url().max(2000),
    keys: z
      .object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(200) })
      .strict(),
  })
  .strict();

export function pushRoutes(
  app: FastifyInstance,
  options: { settings: PushSettings; clock: Clock },
): void {
  const signedIn = route({
    principals: ["owner_manager", "staff"],
    module: "core",
    idempotency: "none",
  });

  /** The public half of the VAPID pair: what the browser subscribes with. */
  app.get(
    "/v1/push/vapid-key",
    { config: route({ principals: ["public"], module: "core", rateLimit: false }) },
    async () => ({ public_key: options.settings.publicKey }),
  );

  /** This phone becomes the signed-in person's staff_phone at the venue. */
  app.post<{ Params: VenueParams; Body: unknown }>(
    "/v1/venues/:venueId/devices/staff-phone",
    { config: signedIn },
    async (request, reply) => {
      const p = request.principal;
      if (p.kind !== "user") throw new ApiError("forbidden", "you can't call this");
      const parsed = staffPhoneBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { name, public_key }");
      const device = await request.inVenue((c) =>
        createStaffPhone(c, {
          venueId: request.venueId!,
          userId: p.userId,
          name: parsed.data.name,
          publicJwk: parsed.data.public_key,
        }),
      );
      return reply.code(201).send({ device_id: device.id, venue_id: request.venueId });
    },
  );

  /** The phone's push subscription: signed by the phone, for the person signed in on it. */
  app.post<{ Params: VenueParams; Body: unknown }>(
    "/v1/venues/:venueId/push/subscriptions",
    { config: signedIn },
    async (request, reply) => {
      const p = request.principal;
      const device = request.signedDevice;
      if (p.kind !== "user") throw new ApiError("forbidden", "you can't call this");
      if (!device || device.kind !== "staff_phone" || device.venueId !== request.venueId)
        throw new ApiError("forbidden", "a subscription is signed by the paired phone");
      const parsed = subscriptionBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { endpoint, keys }");
      const saved = await request.inVenue(async (c: Queryable) => {
        const owner = await c.query<{ user_id: string | null; revoked_at: string | null }>(
          "select user_id, revoked_at::text from devices where venue_id = $1 and id = $2",
          [request.venueId, device.deviceId],
        );
        const row = owner.rows[0];
        if (!row || row.revoked_at !== null)
          throw new ApiError("forbidden", "this device was revoked");
        if (row.user_id !== p.userId)
          throw new ApiError("forbidden", "that phone belongs to someone else");
        return savePushSubscription(c, {
          venueId: request.venueId!,
          deviceId: device.deviceId,
          endpoint: parsed.data.endpoint,
          keys: parsed.data.keys,
        });
      });
      return reply.code(201).send({ subscription_id: saved.id });
    },
  );

  /** A test alert to the signed-in person's own phones, so setup can be checked on the spot. */
  app.post<{ Params: VenueParams }>(
    "/v1/venues/:venueId/push/test",
    { config: signedIn },
    async (request, reply) => {
      const p = request.principal;
      if (p.kind !== "user") throw new ApiError("forbidden", "you can't call this");
      const jobId = await request.inVenue((c) =>
        enqueuePush(c, {
          venueId: request.venueId!,
          audience: { kind: "person", userId: p.userId },
          message: { key: "push.test.body", url: "/setup", tag: "test" },
          runAt: options.clock.now(),
        }),
      );
      return reply.code(202).send({ job_id: jobId });
    },
  );
}
