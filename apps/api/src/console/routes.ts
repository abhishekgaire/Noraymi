import type { FastifyInstance } from "fastify";
import type pg from "pg";
import {
  consoleVenue,
  consoleVenues,
  emitEvent,
  listDevices,
  setModuleAllowed,
  setVenueFlag,
  venueFlags,
  venueModules,
  type ConsoleVenue,
  type DeviceListRow,
} from "@west4/db";
import { isModuleId, moduleDef } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import type { ModuleGate } from "../http/module-gate.js";

/**
 * The minimal Console (M1-35; screens.md · Console notes 1, 2, 4, 5): a
 * read-only venue list with device health from the same rows as Admin →
 * Printers & devices, each venue's module allow-list (`venue_modules.allowed`)
 * and its venue flags. Every write runs as the staff member, so the venue
 * tables' audit triggers record them as the actor. Support grants and the
 * emergency actions come in M8; plans, billing and tickets wait for phase 2.
 */
type VenueRow = ConsoleVenue;

/** The health line both Admin and the Console show (spec 09 · Devices at West 4). */
export function deviceHealth(devices: readonly DeviceListRow[]) {
  const live = devices.filter((d) => d.revoked_at === null);
  const tablets = live.filter((d) => d.kind === "room_tablet");
  const readers = live.filter((d) => d.kind === "reader");
  const router = live.find((d) => d.kind === "router");
  const backup = router?.network?.["cellular_backup"];
  return {
    tablets: { online: tablets.filter((d) => d.online).length, total: tablets.length },
    readers: { online: readers.filter((d) => d.online).length, total: readers.length },
    router: router
      ? {
          online: router.online,
          backup_internet: backup === true ? "on" : backup === false ? "off" : null,
          on_backup_now: router.network?.["on_backup_now"] === true,
        }
      : null,
    devices: { online: live.filter((d) => d.online).length, total: live.length },
  };
}

export function consoleRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool; gate: ModuleGate },
): void {
  const read = route({ principals: ["console"], module: "core" });
  const write = route({ principals: ["console"], module: "core", idempotency: "optional" });

  const staffOf = (request: { principal: { kind: string } }) => {
    const p = request.principal as { kind: string; staffId?: string; email?: string };
    if (p.kind !== "console" || !p.staffId) throw new ApiError("forbidden", "you can't call this");
    return { id: p.staffId, email: p.email ?? "" };
  };

  const venueOrThrow = async (venueId: string): Promise<VenueRow> => {
    if (!/^[0-9a-f-]{36}$/i.test(venueId)) throw new ApiError("not_found", "no such venue");
    const venue = await consoleVenue(options.pool, venueId);
    if (!venue) throw new ApiError("not_found", "no such venue");
    return venue;
  };

  app.get("/v1/console/venues", { config: read }, async (request) => {
    const staff = staffOf(request);
    const venues = await consoleVenues(options.pool);
    const out = [];
    for (const v of venues) {
      const devices = await app.db.withVenue(
        { venueId: v.id, userId: staff.id, requestId: request.requestId },
        (c) => listDevices(c, v.id),
      );
      out.push({ ...v, health: deviceHealth(devices) });
    }
    return { venues: out };
  });

  app.get<{ Params: { v: string } }>("/v1/console/venues/:v", { config: read }, async (request) => {
    const staff = staffOf(request);
    const venue = await venueOrThrow(request.params.v);
    const context = { venueId: venue.id, userId: staff.id, requestId: request.requestId };
    const [modules, flags, devices] = await app.db.withVenue(context, (c) =>
      Promise.all([venueModules(c, venue.id), venueFlags(c, venue.id), listDevices(c, venue.id)]),
    );
    return {
      venue,
      health: deviceHealth(devices),
      modules: modules.map((m) => {
        const def = moduleDef(m.module_id);
        return {
          id: m.module_id,
          allowed: m.allowed,
          state: m.state,
          core: def.core,
          phase1: def.phase1,
        };
      }),
      flags,
    };
  });

  /**
   * The allow-list. Allowing makes the module switchable in Admin → Features at
   * once (a settings.changed event reaches the owner's open screen). Stopping
   * allowing a module the venue has on is refused until the venue turns it off:
   * nothing disappears mid-service (cautious default, flagged in M1-35).
   */
  app.patch<{ Params: { v: string; id: string }; Body: { allowed?: boolean } }>(
    "/v1/console/venues/:v/modules/:id",
    { config: write },
    async (request) => {
      const staff = staffOf(request);
      const venue = await venueOrThrow(request.params.v);
      const id = request.params.id;
      if (!isModuleId(id)) throw new ApiError("not_found", `no module "${id}"`);
      const allowed = request.body?.allowed;
      if (typeof allowed !== "boolean") throw new ApiError("invalid_request", "send { allowed }");
      if (moduleDef(id).core && !allowed)
        throw new ApiError("invalid_request", "a core module is always allowed and always on");
      const context = { venueId: venue.id, userId: staff.id, requestId: request.requestId };
      const result = await app.db.withVenue(context, async (c) => {
        const rows = await venueModules(c, venue.id);
        const row = rows.find((r) => r.module_id === id);
        if (!allowed && row && row.state !== "off")
          throw new ApiError(
            "invalid_request",
            "the venue has this module on: it turns off in Admin → Features first",
            { details: { state: row.state } },
          );
        await setModuleAllowed(c, venue.id, id, allowed, staff.id);
        await emitEvent(c, {
          venueId: venue.id,
          type: "settings.changed",
          entityId: "modules",
          entityVersion: 0,
        });
        return { id, allowed, state: row?.state ?? "off" };
      });
      options.gate.forget(venue.id);
      return result;
    },
  );

  /** Venue flags: beta and rollout switches, our own test venue first in line. */
  app.put<{ Params: { v: string; flag: string }; Body: { on?: boolean } }>(
    "/v1/console/venues/:v/flags/:flag",
    { config: write },
    async (request) => {
      const staff = staffOf(request);
      const venue = await venueOrThrow(request.params.v);
      const flag = request.params.flag;
      if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(flag))
        throw new ApiError("invalid_request", "a flag is a short lower-case name");
      const on = request.body?.on;
      if (typeof on !== "boolean") throw new ApiError("invalid_request", "send { on }");
      const context = { venueId: venue.id, userId: staff.id, requestId: request.requestId };
      const flags = await app.db.withVenue(context, async (c) => {
        await setVenueFlag(c, venue.id, flag, on, staff.email || staff.id);
        await emitEvent(c, {
          venueId: venue.id,
          type: "settings.changed",
          entityId: "flags",
          entityVersion: 0,
        });
        return venueFlags(c, venue.id);
      });
      return { venue_id: venue.id, flags };
    },
  );
}
