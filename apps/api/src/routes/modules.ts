import type { FastifyInstance } from "fastify";
import { emitEvent, setModuleState, venueFlags, venueModules, statesOf } from "@west4/db";
import {
  isModuleId,
  missingNeeds,
  moduleDef,
  needsRoomOrdersConfirm,
  t,
  turnsOffWith,
  type ModuleId,
  type ModuleState,
  type ModuleStates,
  type Clock,
} from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import type { ModuleGate } from "../http/module-gate.js";
import type { Queryable } from "@west4/db";
import { merchantCategoryPasses } from "../payments/go-live.js";
import { kitchenNeeds, kitchenNeedsText, kitchenOrdersOpen } from "../kitchen/module.js";

interface VenueParams {
  venueId: string;
}

/** Each module registers the check that refuses "off" while it has open work, once its tables land. */
export type OpenWorkCheck = (client: Queryable, venueId: string) => Promise<string | null>;
export const openWorkChecks: Partial<Record<ModuleId, OpenWorkCheck>> = {
  kitchen: kitchenOrdersOpen,
};

/**
 * Modules and flags (spec 08 · Settings and modules; M1-13):
 *   GET   /v1/venues/{v}/modules          every module with allowed, state, needs and what it hides
 *   PATCH /v1/venues/{v}/modules/{id}     { state, confirm? }: on, stopping or off; a change that turns
 *                                         others off answers the confirm first and applies nothing
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
            ...(r.module_id === "kitchen" ? { still_needs: kitchen } : {}),
          };
        }),
      };
    },
  );

  app.patch<{
    Params: VenueParams & { id: string };
    Body: { state?: ModuleState; confirm?: boolean };
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
      if (row.state === target) return { applied: false, unchanged: true as const, state: target };

      if (target === "on") {
        if (!row.allowed) throw new ApiError("forbidden", t("en", "modules.refused.notAllowed"));
        // Bar tabs & quick sale wait for the go-live checklist's merchant category (M4-29).
        if (id === "bar_tabs" && !(await merchantCategoryPasses(c, venueId)))
          throw new ApiError("invalid_request", t("en", "modules.refused.merchantCategory"), {
            details: { reason: "merchant_category" },
          });
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
          if (needs.length > 0)
            throw new ApiError("invalid_request", kitchenNeedsText(needs), {
              details: { reason: "kitchen_needs", missing: needs },
            });
        }
        await setModuleState(c, venueId, id, "on", updatedBy);
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
