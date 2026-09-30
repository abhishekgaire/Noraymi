import type { FastifyInstance } from "fastify";
import { emitEvent, permissionOverrides, setPermission } from "@west4/db";
import {
  actions,
  defaultPermissions,
  isAction,
  isRole,
  permissionFor,
  roles,
  switchableByAdmin,
} from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import type { PermissionGate } from "../http/permission-gate.js";

interface VenueParams {
  venueId: string;
}

/**
 * The permission table (M1-14), for Admin → Team (M1-31):
 *   GET   /v1/venues/{v}/permissions                     the effective table: defaults with the venue's changes applied
 *   PATCH /v1/venues/{v}/permissions/{role}/{action}     { allowed }: only the rows Admin may switch (the front desk's bar POS and accepting orders)
 */
export function permissionsRoutes(app: FastifyInstance, options: { gate: PermissionGate }): void {
  app.get<{ Params: VenueParams }>(
    "/v1/venues/:venueId/permissions",
    { config: route({ principals: ["owner_manager"], module: "core", action: "admin.access" }) },
    async (request) => {
      const overrides = await request.inVenue((c) => permissionOverrides(c, request.venueId!));
      return {
        roles,
        rows: actions.map((action) => ({
          action,
          switchable: switchableByAdmin.filter((s) => s.action === action).map((s) => s.role),
          ...Object.fromEntries(
            roles.map((role) => [role, permissionFor(overrides, role, action).allowed]),
          ),
          defaults: defaultPermissions[action],
        })),
      };
    },
  );

  app.patch<{
    Params: VenueParams & { role: string; action: string };
    Body: { allowed?: boolean };
  }>(
    "/v1/venues/:venueId/permissions/:role/:action",
    {
      config: route({
        principals: ["owner_manager"],
        module: "core",
        action: "admin.team",
        idempotency: "optional",
      }),
    },
    async (request) => {
      const { role, action } = request.params;
      if (!isRole(role) || !isAction(action))
        throw new ApiError("not_found", "no such role or action");
      if (!switchableByAdmin.some((s) => s.role === role && s.action === action)) {
        throw new ApiError(
          "invalid_request",
          "only the front desk's bar POS and accepting orders can be switched here",
        );
      }
      const allowed = request.body?.allowed;
      if (typeof allowed !== "boolean")
        throw new ApiError("invalid_request", "send { allowed: true | false }");
      const venueId = request.venueId!;
      await request.inVenue(async (c) => {
        await setPermission(
          c,
          venueId,
          role,
          action,
          allowed,
          false,
          request.principal.kind === "user" ? request.principal.userId : undefined,
        );
        await emitEvent(c, {
          venueId,
          type: "settings.changed",
          entityId: "permissions",
          entityVersion: 0,
        });
      });
      options.gate.forget(venueId);
      return { role, action, allowed };
    },
  );
}
