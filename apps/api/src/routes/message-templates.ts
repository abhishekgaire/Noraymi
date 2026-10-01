import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { emitEvent, templates, venueModules } from "@west4/db";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { render } from "../texts/queue.js";

/**
 * Admin → Texts (M2-10; spec 11 · The automatic texts):
 *   GET   /v1/venues/{v}/message-templates          the 14 texts in the spec's order, with an example of each
 *   PATCH /v1/venues/{v}/message-templates/{key}    { body?, on? }
 * A text that's off never sends. The two marketing texts can't be turned on
 * while the Marketing texts module is off; and until they have their own
 * opt-in (M5) they never send anyway.
 */
export const TEMPLATE_EXAMPLES: Readonly<
  Record<string, Readonly<Record<string, string | number>>>
> = {
  booking_confirmed: {
    party: 6,
    time: "9:30 PM",
    date: "Sat Sep 26",
    gratuity: "20%",
    deposit: "$60",
    cutoff: "Fri 9:30 PM",
    link: "west4karaoke.com/b/…",
  },
  reminder: { venue: "West 4", party: 6, time: "9:30 PM", address: "186 W 4th St" },
  room_code: { room: "Room 9", code: "KX4M7", link: "west4karaoke.com/r/…" },
  room_ready: { room: "Room 11" },
  offer_expiring: { venue: "West 4" },
  please_wrap_up: { room: "Room 9" },
  booked_time_ending: { room: "Room 9", end: "11:00 PM", close: "4 AM" },
  receipt: { amount: "$154.65", link: "west4karaoke.com/rc/…" },
  deposit_refund: { amount: "$60.00", date: "Sat Sep 26" },
  payment_link: {
    venue: "West 4",
    room: "VIP room",
    party: 22,
    date: "Fri Sep 25",
    time: "9:30 PM",
    amount: "$250.00",
    link: "west4karaoke.com/b/…",
  },
  running_late_reply: { until: "10:45 PM" },
  up_next: {},
  review_ask: { link: "g.page/west4/review" },
  birthday: {},
};

const preview = (key: string, body: string): string | null => {
  try {
    return render(body, TEMPLATE_EXAMPLES[key] ?? {});
  } catch {
    return null;
  }
};

const patchBody = z
  .object({ body: z.string().trim().min(1).max(480).optional(), on: z.boolean().optional() })
  .strict();

export function messageTemplateRoutes(app: FastifyInstance): void {
  const read = route({ principals: ["owner_manager"], module: "core", action: "admin.access" });
  const write = route({
    principals: ["owner_manager"],
    module: "core",
    action: "admin.access",
    idempotency: "optional",
  });

  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/message-templates",
    { config: read },
    async (request) =>
      request.inVenue(async (c) => {
        const venueId = request.venueId!;
        const marketingOff =
          (await venueModules(c, venueId)).find((m) => m.module_id === "marketing_texts")?.state !==
          "on";
        return {
          marketing_module_on: !marketingOff,
          templates: (await templates(c, venueId)).map((t) => ({
            ...t,
            example: preview(t.key, t.body),
            locked_off: t.category === "marketing" && marketingOff,
          })),
        };
      }),
  );

  app.patch<{ Params: { venueId: string; templateKey: string }; Body: unknown }>(
    "/v1/venues/:venueId/message-templates/:templateKey",
    { config: write },
    async (request) => {
      const parsed = patchBody.safeParse(request.body);
      if (!parsed.success || Object.keys(parsed.data).length === 0)
        throw new ApiError("invalid_request", "send { body } and/or { on }");
      const b = parsed.data;
      const venueId = request.venueId!;
      const p = request.principal;
      return request.inVenue(async (c) => {
        const t = (await templates(c, venueId)).find((x) => x.key === request.params.templateKey);
        if (!t) throw new ApiError("not_found", "no such text");
        if (b.on === true && t.category === "marketing") {
          const marketing = (await venueModules(c, venueId)).find(
            (m) => m.module_id === "marketing_texts",
          );
          if (marketing?.state !== "on")
            throw new ApiError(
              "invalid_request",
              "marketing texts can't be turned on while Marketing texts is off",
              {
                details: { reason: "marketing_off" },
              },
            );
        }
        if (b.body !== undefined) {
          // Only the slots this text already has may appear; a new one would have nothing to fill it.
          const slots = new Set([...t.body.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
          const unknown = [...b.body.matchAll(/\{(\w+)\}/g)]
            .map((m) => m[1]!)
            .filter((n) => !slots.has(n));
          if (unknown.length > 0)
            throw new ApiError("invalid_request", `this text has no {${unknown[0]}}`, {
              details: { reason: "unknown_slot" },
            });
        }
        await c.query(
          `update message_templates set body = coalesce($3, body), "on" = coalesce($4, "on"), updated_by = $5, updated_at = now()
            where venue_id = $1 and key = $2`,
          [venueId, t.key, b.body ?? null, b.on ?? null, p.kind === "user" ? p.userId : null],
        );
        await emitEvent(c, {
          venueId,
          type: "settings.changed",
          entityId: "message_templates",
          entityVersion: 0,
        });
        const updated = (await templates(c, venueId)).find((x) => x.key === t.key)!;
        return { template: { ...updated, example: preview(updated.key, updated.body) } };
      });
    },
  );
}
