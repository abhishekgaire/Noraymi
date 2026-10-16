import type { FastifyInstance } from "fastify";
import type { Clock, Locale } from "@west4/shared";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { guestScreenView, registerFor, showOnGuestScreen } from "../receipts/guest-screen.js";

/**
 * Guest screen (P-18; module guest_screen, off by default):
 *   POST /v1/venues/{v}/guest-screen/showing   { check_id: uuid | null, draft?: boolean }
 *        the register (the bar POS on a bar or front-desk computer) says which check it shows; a
 *        locked computer may only clear it (check_id null). { following: false } from a device that
 *        drives no screen (a phone, an unpaired browser).
 *   GET  /v1/venues/{v}/guest-screen?lang=en|es&since=<fp>
 *        the screen's view of its register: a paired guest display, a bar computer's own window, or
 *        staff on that computer. With `since` equal to the answer's fingerprint: { unchanged: true }.
 * A switched-off module answers module_off.
 */
const showingBody = z
  .object({ check_id: z.string().uuid().nullable(), draft: z.boolean().optional() })
  .strict();

export function guestScreenRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  app.post<{ Params: { venueId: string }; Body: unknown }>(
    "/v1/venues/:venueId/guest-screen/showing",
    {
      config: route({
        principals: ["owner_manager", "staff", "shared_device"],
        module: "guest_screen",
      }),
    },
    async (request) => {
      const parsed = showingBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError("invalid_request", "send { check_id: uuid | null, draft? }");
      const p = request.principal;
      let deviceId: string | null;
      let membershipId: string | null = null;
      if (p.kind === "device") {
        if (parsed.data.check_id !== null)
          throw new ApiError("forbidden", "a locked computer can only clear its guest screen");
        deviceId = p.deviceId;
      } else if (p.kind === "user") {
        membershipId =
          p.memberships.find((m) => m.venueId === request.venueId)?.membershipId ?? null;
        deviceId = request.signedDevice?.deviceId ?? request.session?.deviceId ?? null;
      } else throw new ApiError("forbidden", "a register drives the guest screen");
      if (!deviceId) return { following: false };
      const shown = await request.inVenue((c) =>
        showOnGuestScreen(c, request.venueId!, {
          deviceId: deviceId!,
          checkId: parsed.data.check_id,
          membershipId,
          draft: parsed.data.draft === true,
          at: options.clock.now().toString(),
        }),
      );
      return shown ? { following: true, version: shown.version } : { following: false };
    },
  );

  app.get<{ Params: { venueId: string }; Querystring: { lang?: string; since?: string } }>(
    "/v1/venues/:venueId/guest-screen",
    {
      config: route({
        principals: ["guest_display", "shared_device", "owner_manager", "staff"],
        module: "guest_screen",
      }),
    },
    async (request) => {
      const locale: Locale = request.query.lang === "es" ? "es" : "en";
      const since = typeof request.query.since === "string" ? request.query.since : undefined;
      const p = request.principal;
      return request.inVenue(async (c) => {
        const venueId = request.venueId!;
        const own =
          p.kind === "device"
            ? p.deviceId
            : (request.signedDevice?.deviceId ?? request.session?.deviceId ?? null);
        const target =
          p.kind === "device" && p.deviceKind === "guest_display"
            ? await registerFor(c, venueId, { display: p.deviceId })
            : own
              ? await registerFor(c, venueId, { register: own })
              : { register: null, needsRegister: false };
        return guestScreenView(c, venueId, target, {
          now: options.clock.now(),
          locale,
          ...(since ? { since } : {}),
        });
      });
    },
  );
}
