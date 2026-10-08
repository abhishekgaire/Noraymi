import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { ESCALATE_AFTER_MINUTES } from "../ops/alert-rules.js";
import { ROTA_HINT, ackPage, listPages, readRota, SLOTS } from "../ops/paging.js";

/**
 * Pages in the Console (M8-17; spec 13 · On call): the open pages and the recent ones, who is on
 * call, and Acknowledge, which stops a page escalating to the second responder. Our staff only.
 */
export function pagingConsoleRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool; clock: Clock },
): void {
  const read = route({ principals: ["console"], module: "core" });
  const write = route({ principals: ["console"], module: "core", idempotency: "optional" });
  const staffOf = (request: { principal: { kind: string } }) => {
    const p = request.principal as { kind: string; staffId?: string };
    if (p.kind !== "console" || !p.staffId) throw new ApiError("forbidden", "you can't call this");
    return p.staffId;
  };

  app.get("/v1/console/pages", { config: read }, async (request) => {
    staffOf(request);
    const [pages, rota] = await Promise.all([listPages(options.pool), readRota(options.pool)]);
    return {
      pages,
      escalate_after_minutes: ESCALATE_AFTER_MINUTES,
      rota: SLOTS.map((slot) => {
        const r = rota.find((x) => x.slot === slot);
        return r
          ? { slot, name: r.name, email: r.email, text: r.phone !== null }
          : { slot, name: null, email: null, text: false };
      }),
      rota_hint: rota.length < SLOTS.length ? ROTA_HINT : null,
    };
  });

  app.post<{ Params: { pageId: string } }>(
    "/v1/console/pages/:pageId/ack",
    { config: write },
    async (request) => {
      const staffId = staffOf(request);
      if (!/^[0-9a-f-]{36}$/i.test(request.params.pageId))
        throw new ApiError("not_found", "no such page");
      const page = await ackPage(options.pool, request.params.pageId, staffId, options.clock.now());
      if (!page) {
        const exists = await options.pool.query("select 1 from pages where id = $1", [
          request.params.pageId,
        ]);
        if (exists.rowCount === 0) throw new ApiError("not_found", "no such page");
        throw new ApiError("version_conflict", "already acknowledged");
      }
      return { page };
    },
  );
}
