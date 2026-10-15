import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Queryable } from "@west4/db";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";

/**
 * One bell for everything waiting (P-11; spec 10 · The bell; module `bell`). The staff app works
 * out what's waiting from the lists it already reads (approvals, the board's alerts, bar orders,
 * guest texts, tickets that didn't print), each gated by its own module and role; what the API
 * keeps is which of those each person has marked read:
 *   GET  /v1/venues/{v}/bell/reads            { keys } the signed-in person's, the last few days
 *   POST /v1/venues/{v}/bell/reads { keys }   mark these read; a key already read stays as it was
 * Off, both answer 404 module_off; the menu badges stay either way.
 */
const READS_KEPT_HOURS = 72;
const keysBody = z
  .object({
    keys: z.array(z.string().min(1).max(200)).min(1).max(200),
  })
  .strict();

const who = (request: FastifyRequest) => {
  const p = request.principal;
  if (p.kind !== "user") throw new ApiError("forbidden", "the bell is a person's own");
  return p.userId;
};

/** The keys one person marked read since an instant, newest first. */
export async function bellReads(
  c: Queryable,
  venueId: string,
  userId: string,
  since: string,
): Promise<string[]> {
  const r = await c.query<{ item_key: string }>(
    `select item_key from bell_reads
      where venue_id = $1 and user_id = $2 and read_at >= $3
      order by read_at desc limit 2000`,
    [venueId, userId, since],
  );
  return r.rows.map((row) => row.item_key);
}

/** Marks keys read for one person; a key already read keeps its first time. */
export async function markBellRead(
  c: Queryable,
  venueId: string,
  userId: string,
  keys: readonly string[],
  at: string,
): Promise<void> {
  await c.query(
    `insert into bell_reads (venue_id, user_id, item_key, read_at)
     select $1, $2, k, $4 from unnest($3::text[]) as k
     on conflict (venue_id, user_id, item_key) do nothing`,
    [venueId, userId, keys, at],
  );
}

export function bellRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  const config = route({ principals: ["owner_manager", "staff"], module: "bell" });

  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/bell/reads",
    { config },
    async (request) => {
      const userId = who(request);
      const since = options.clock.now().subtract({ hours: READS_KEPT_HOURS }).toString();
      return {
        keys: await request.inVenue((c) => bellReads(c, request.venueId!, userId, since)),
      };
    },
  );

  app.post<{ Params: { venueId: string }; Body: unknown }>(
    "/v1/venues/:venueId/bell/reads",
    { config },
    async (request) => {
      const userId = who(request);
      const parsed = keysBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "keys: 1 to 200 item keys");
      const keys = [...new Set(parsed.data.keys)];
      const at = options.clock.now().toString();
      await request.inVenue((c) => markBellRead(c, request.venueId!, userId, keys, at));
      return { keys };
    },
  );
}
