import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createSetupRequest,
  ImportInvalid,
  ImportRefused,
  listSetupRequests,
  prepareMenuSheet,
  resolveVenue,
  runImport,
  type ImportReport,
  type OpenPoint,
} from "@west4/db";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";

/**
 * Set up your venue's step 8, the menu (O-10; spec 17 · Step details 8). Typing items is Admin →
 * Menu's own editor and routes. Here:
 *   POST /v1/venues/{v}/setup/menu-sheet  { files: [{ name, text }], save }
 *     the importer's menu format (M9-04) through the importer itself, as the venue (app_rw):
 *     save false is the dry run the owner checks (rolled back, nothing kept but the run's
 *     report), save true is "Looks right". Answers what the file holds and its open points.
 *   GET  /v1/venues/{v}/setup/menu
 *     the open points of the last spreadsheet saved, and the requests sent to our team.
 *   POST /v1/venues/{v}/setup/requests    { kind: "menu", file_id, note? }
 *     a PDF or a photo of the menu (an uploaded menu_source file) for our team to type in;
 *     it lands in the Console, and nothing is read from it automatically.
 */
const sheetBody = z
  .object({
    files: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(200),
            text: z
              .string()
              .min(1)
              .max(2 * 1024 * 1024),
          })
          .strict(),
      )
      .min(1)
      .max(4),
    save: z.boolean(),
  })
  .strict();

const requestBody = z
  .object({
    kind: z.literal("menu"),
    file_id: z.string().uuid(),
    note: z.string().trim().min(1).max(500).nullable().optional(),
  })
  .strict();

interface VenueParams {
  venueId: string;
}

/** What the step shows of a run: counts, money in the file, open points, the bar grid. */
function summary(r: ImportReport) {
  const menu = r.kinds.menu;
  return {
    run_id: r.run_id,
    mode: r.mode,
    menu_lines: menu?.in_files ?? 0,
    new_lines: menu?.loaded ?? 0,
    already: menu?.already ?? 0,
    changed: r.changed.length,
    choices: r.kinds.modifiers?.in_files ?? 0,
    packages: r.kinds.packages?.in_files ?? 0,
    cents_in_files: menu?.cents_in_files ?? 0,
    open_points: r.open_points,
    not_on_grid: r.layout?.not_placed.map((x) => x.item) ?? [],
    layout_skipped: r.layout?.skipped ?? null,
    listed: r.listed.map((x) => `${x.file}:${x.line} ${x.message}`),
    reconciles: r.reconciles,
  };
}

export function setupMenuRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  const read = route({
    principals: ["owner_manager"],
    module: "core",
    action: "admin.access",
    assurance: "passkey",
  });
  const write = route({
    principals: ["owner_manager"],
    module: "core",
    action: "admin.access",
    assurance: "passkey",
    idempotency: "optional",
  });

  app.post<{ Params: VenueParams; Body: unknown }>(
    "/v1/venues/:venueId/setup/menu-sheet",
    { config: write, bodyLimit: 6 * 1024 * 1024 },
    async (request) => {
      const parsed = sheetBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError("invalid_request", "send { files: [{ name, text }], save }");
      const venueId = request.venueId!;
      const venue = await request.inVenue((c) => resolveVenue(c as never, venueId));
      let sheet;
      try {
        sheet = prepareMenuSheet(parsed.data.files, venue.timeZone);
      } catch (e) {
        if (e instanceof ImportRefused)
          throw new ApiError("invalid_request", "a file holds a PIN or a card number", {
            details: {
              problems: e.refusals.map(
                (r) =>
                  `${r.file}:${r.line} ${r.column}: ${r.why === "pin" ? "a PIN" : "a card number"}`,
              ),
            },
          });
        if (e instanceof Error)
          throw new ApiError("invalid_request", e.message, { details: { problems: [e.message] } });
        throw e;
      }
      if (sheet.prepared === null)
        throw new ApiError("invalid_request", "the files can't be read as a menu", {
          details: { problems: sheet.problems },
        });
      try {
        const report = await runImport({
          pool: app.db.pool,
          venue,
          prepared: sheet.prepared,
          dryRun: !parsed.data.save,
          role: "app_rw",
          now: options.clock.now(),
        });
        return summary(report);
      } catch (e) {
        if (e instanceof ImportInvalid)
          throw new ApiError("invalid_request", "the menu has problems; nothing was saved", {
            details: { problems: e.problems.map((p) => `${p.file}:${p.line} ${p.message}`) },
          });
        throw e;
      }
    },
  );

  app.get<{ Params: VenueParams }>(
    "/v1/venues/:venueId/setup/menu",
    { config: read },
    async (request) =>
      request.inVenue(async (c) => {
        const venueId = request.venueId!;
        const last = await c.query<{ report: { open_points?: OpenPoint[] } }>(
          `select report from import_runs
            where venue_id = $1 and mode = 'live' and state = 'done'
              and files @> '[{"kind": "menu"}]'::jsonb and report ? 'open_points'
            order by finished_at desc nulls last limit 1`,
          [venueId],
        );
        return {
          open_points: last.rows[0]?.report.open_points ?? [],
          requests: await listSetupRequests(c, venueId),
        };
      }),
  );

  app.post<{ Params: VenueParams; Body: unknown }>(
    "/v1/venues/:venueId/setup/requests",
    { config: write },
    async (request, reply) => {
      const parsed = requestBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { kind, file_id, note? }");
      const p = request.principal;
      if (p.kind !== "user") throw new ApiError("forbidden", "you can't call this");
      const venueId = request.venueId!;
      const made = await request.inVenue(async (c) => {
        const file = await c.query<{ kind: string }>(
          "select kind from files where venue_id = $1 and id = $2 and removed_at is null",
          [venueId, parsed.data.file_id],
        );
        if (file.rows[0]?.kind !== "menu_source")
          throw new ApiError("invalid_request", "upload the menu's PDF or photo first");
        return createSetupRequest(c, venueId, {
          kind: "menu",
          fileId: parsed.data.file_id,
          note: parsed.data.note ?? null,
          userId: p.userId,
        });
      });
      return reply.code(201).send(made);
    },
  );
}
