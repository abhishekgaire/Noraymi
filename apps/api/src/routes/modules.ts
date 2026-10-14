import type { FastifyInstance } from "fastify";
import {
  emitEvent,
  latestSetting,
  setModuleState,
  setModuleWanted,
  venueFlags,
  venueModules,
  statesOf,
} from "@west4/db";
import {
  isModuleId,
  missingNeeds,
  moduleDef,
  needsRoomOrdersConfirm,
  t,
  turnsOffWith,
  walkInTakesOf,
  type ModuleId,
  type ModuleState,
  type ModuleStates,
  type Clock,
} from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import type { ModuleGate } from "../http/module-gate.js";
import type { Queryable } from "@west4/db";
import {
  kitchenNeeds,
  kitchenNeedsText,
  kitchenOrdersOpen,
  menusFollowKitchen,
} from "../kitchen/module.js";

interface VenueParams {
  venueId: string;
}

/** Each module registers the check that refuses "off" while it has open work, once its tables land. */
export type OpenWorkCheck = (client: Queryable, venueId: string) => Promise<string | null>;
export const openWorkChecks: Partial<Record<ModuleId, OpenWorkCheck>> = {
  kitchen: kitchenOrdersOpen,
  // Keep the card behind the bar (D124): not while it's the walk-in choice, nor while a card is held.
  card_behind_bar: async (c, venueId) => {
    const deposit = await latestSetting(c, venueId, "deposit");
    if (walkInTakesOf(deposit?.value) === "cardBehindBar")
      return t("en", "modules.refused.walkInChoice");
    const held = await c.query(
      "select 1 from check_held_cards where venue_id = $1 and returned_at is null and cleared_at is null limit 1",
      [venueId],
    );
    return held.rowCount ? t("en", "modules.refused.cardsHeld") : null;
  },
};

/**
 * Modules and flags (spec 08 · Settings and modules; M1-13):
 *   GET   /v1/venues/{v}/modules          every module with allowed, state, needs and what it hides
 *   PATCH /v1/venues/{v}/modules/{id}     { state, confirm? }: on, stopping or off; a change that turns
 *                                         others off answers the confirm first and applies nothing;
 *                                         { state: "on", when_ready: true } on Kitchen & food before
 *                                         its needs records "on once ready" and answers waiting (D129)
 *   GET   /v1/venues/{v}/flags            the venue's beta and rollout switches
 */
export function modulesRoutes(
  app: FastifyInstance,
  options: { gate: ModuleGate; clock: Clock },
): void {
  const read = route({
    principals: ["owner_manager", "staff", "shared_device"],
    module: "core",
    action: "admin.access",
  });
  const write = route({
    principals: ["owner_manager"],
    module: "core",
    action: "admin.access",
    idempotency: "optional",
  });

  app.get<{ Params: VenueParams }>(
    "/v1/venues/:venueId/modules",
    { config: read },
    async (request) => {
      const { rows, kitchen } = await request.inVenue(async (c) => {
        const rows = await venueModules(c, request.venueId!);
        // What Kitchen & food still needs, so Admin → Features can say it while the switch stays off.
        const k = rows.find((r) => r.module_id === "kitchen");
        const kitchen =
          k && k.allowed && k.state === "off"
            ? await kitchenNeeds(c, request.venueId!, options.clock)
            : [];
        return { rows, kitchen };
      });
      const states = statesOf(rows);
      return {
        modules: rows.map((r) => {
          const def = moduleDef(r.module_id);
          return {
            id: r.module_id,
            allowed: r.allowed,
            state: r.state,
            core: def.core,
            phase1: def.phase1,
            needs: def.needs,
            hides: def.hides,
            turns_off_with_it: turnsOffWith(states, r.module_id),
            // Chosen "on once ready" (D129): turns on by itself once its needs are in.
            wanted: r.wanted,
            ...(r.module_id === "kitchen" ? { still_needs: kitchen } : {}),
          };
        }),
      };
    },
  );

  app.patch<{
    Params: VenueParams & { id: string };
    Body: { state?: ModuleState; confirm?: boolean; when_ready?: boolean };
  }>("/v1/venues/:venueId/modules/:id", { config: write }, async (request) => {
    const id = request.params.id;
    if (!isModuleId(id)) throw new ApiError("not_found", `no module "${id}"`);
    const target = request.body?.state;
    if (target !== "on" && target !== "stopping" && target !== "off")
      throw new ApiError("invalid_request", "state must be on, stopping or off");
    const def = moduleDef(id);
    if (def.core) throw new ApiError("invalid_request", t("en", "modules.refused.coreAlwaysOn"));
    const venueId = request.venueId!;
    const updatedBy = request.principal.kind === "user" ? request.principal.userId : undefined;

    const result = await request.inVenue(async (c) => {
      const rows = await venueModules(c, venueId);
      const states: ModuleStates = statesOf(rows);
      const row = rows.find((r) => r.module_id === id)!;
      // Off while it waits "on once ready" (D129): the owner no longer wants it.
      if (target === "off" && row.wanted && row.state === "off") {
        await setModuleWanted(c, venueId, id, false, updatedBy);
        await emitEvent(c, {
          venueId,
          type: "settings.changed",
          entityId: "modules",
          entityVersion: 0,
        });
        return { applied: true, changed: [] as ModuleId[] };
      }
      if (row.state === target) return { applied: false, unchanged: true as const, state: target };

      if (target === "on") {
        if (!row.allowed) throw new ApiError("forbidden", t("en", "modules.refused.notAllowed"));
        const missing = missingNeeds(states, id);
        if (missing.length > 0) {
          throw new ApiError(
            "invalid_request",
            t("en", "modules.refused.needs").replace(
              "{list}",
              missing.map((m) => t("en", `module.${m}.name`)).join(", "),
            ),
            { details: { needs: missing } },
          );
        }
        // Kitchen & food also needs a paired kitchen printer and the allergy notice (spec 16).
        if (id === "kitchen") {
          const needs = await kitchenNeeds(c, venueId, options.clock);
          if (needs.length > 0) {
            // On once ready (D129): chosen now, on by itself once the printer and notice are in.
            // The module itself stays off: nothing serves food without them.
            if (request.body?.when_ready === true) {
              await setModuleWanted(c, venueId, id, true, updatedBy);
              await emitEvent(c, {
                venueId,
                type: "settings.changed",
                entityId: "modules",
                entityVersion: 0,
              });
              return { applied: false, waiting: true as const, still_needs: needs };
            }
            throw new ApiError("invalid_request", kitchenNeedsText(needs), {
              details: { reason: "kitchen_needs", missing: needs },
            });
          }
        }
        await setModuleState(c, venueId, id, "on", updatedBy);
        // Food and the allergy notice appear on every menu, the PDF included (K-08).
        if (id === "kitchen") await menusFollowKitchen(c, venueId, options.clock.now());
        await emitEvent(c, {
          venueId,
          type: "settings.changed",
          entityId: "modules",
          entityVersion: 0,
        });
        return { applied: true, changed: [id] as ModuleId[] };
      }

      // stopping or off: what turns off with it
      const dependents = turnsOffWith(states, id);
      if (target === "off") {
        for (const m of [id, ...dependents]) {
          const check = openWorkChecks[m];
          const reason = check ? await check(c, venueId) : null;
          if (reason) throw new ApiError("orders_open", reason, { details: { module: m } });
        }
      }
      if (dependents.length > 0 && request.body?.confirm !== true) {
        const list = t("en", "modules.confirm.theseTurnOffWithIt").replace(
          "{list}",
          dependents.map((m) => t("en", `module.${m}.name`)).join(", "),
        );
        // The room-orders question, and the full list when more than Ordering from the room goes too
        // (Kitchen & food needs Bar screen & tickets as well, K-01).
        const question = needsRoomOrdersConfirm(states, id)
          ? dependents.length > 1
            ? `${t("en", "modules.confirm.roomOrdersNowhereToRing")} ${list}`
            : t("en", "modules.confirm.roomOrdersNowhereToRing")
          : list;
        return { applied: false, needs_confirm: true as const, turns_off: dependents, question };
      }
      for (const m of [id, ...dependents]) await setModuleState(c, venueId, m, target, updatedBy);
      if ([id, ...dependents].includes("kitchen"))
        await menusFollowKitchen(c, venueId, options.clock.now());
      await emitEvent(c, {
        venueId,
        type: "settings.changed",
        entityId: "modules",
        entityVersion: 0,
      });
      return { applied: true, changed: [id, ...dependents] };
    });
    if (result.applied) options.gate.forget(venueId);
    return result;
  });

  app.get<{ Params: VenueParams }>(
    "/v1/venues/:venueId/flags",
    { config: read },
    async (request) => ({
      flags: await request.inVenue((c) => venueFlags(c, request.venueId!)),
    }),
  );
}
