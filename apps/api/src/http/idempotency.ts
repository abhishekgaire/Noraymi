import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Queryable } from "@west4/db";
import { ApiError } from "./errors.js";

/**
 * Idempotency-Key (spec 08 · Idempotency). The key row is written, and
 * committed, before the work starts, so a duplicate that arrives while the
 * first runs sees it. Keyed by venue and caller.
 */
export const PLATFORM_VENUE = "00000000-0000-0000-0000-000000000000";
export const REPLAY_DAYS = 7;

export function requestHash(request: FastifyRequest): string {
  const body = request.body === undefined ? "" : JSON.stringify(request.body);
  return createHash("sha256")
    .update(`${request.method} ${request.routeOptions.url ?? request.url}\n${body}`)
    .digest("hex");
}

export interface StoredResponse {
  readonly status: number;
  readonly body: unknown;
}

interface KeyRow {
  id: string;
  state: "running" | "done" | "failed";
  request_hash: string;
  response: StoredResponse | null;
}

export type ClaimOutcome =
  { kind: "run"; id: string } | { kind: "replay"; response: StoredResponse };

/** Insert the key, or decide what an existing one means. One short transaction. */
export async function claimKey(
  client: Queryable,
  args: { venueId: string; principalId: string; key: string; route: string; hash: string },
): Promise<ClaimOutcome> {
  const inserted = await client.query<{ id: string }>(
    `insert into idempotency_keys (venue_id, principal_id, key, route, request_hash)
     values ($1, $2, $3, $4, $5)
     on conflict (venue_id, principal_id, key) do nothing
     returning id`,
    [args.venueId, args.principalId, args.key, args.route, args.hash],
  );
  if (inserted.rows[0]) return { kind: "run", id: inserted.rows[0].id };

  const existing = await client.query<KeyRow>(
    "select id, state, request_hash, response from idempotency_keys where venue_id = $1 and principal_id = $2 and key = $3 for update",
    [args.venueId, args.principalId, args.key],
  );
  const row = existing.rows[0];
  if (!row)
    throw new ApiError("in_progress", "the same request is being handled; try again in a moment");
  if (row.request_hash !== args.hash) {
    throw new ApiError(
      "key_reused",
      "this Idempotency-Key was already used with a different request",
    );
  }
  if (row.state === "running")
    throw new ApiError("in_progress", "the same request is being handled; try again in a moment");
  if (row.state === "done" && row.response) return { kind: "replay", response: row.response };
  // failed: let this attempt run again
  await client.query(
    "update idempotency_keys set state = 'running', response = null where id = $1",
    [row.id],
  );
  return { kind: "run", id: row.id };
}

export async function finishKey(
  client: Queryable,
  id: string,
  response: StoredResponse | null,
): Promise<void> {
  if (response === null) {
    await client.query("update idempotency_keys set state = 'failed' where id = $1", [id]);
    return;
  }
  await client.query("update idempotency_keys set state = 'done', response = $2 where id = $1", [
    id,
    JSON.stringify(response),
  ]);
}

export function idempotencyKeyOf(request: FastifyRequest): string | undefined {
  const raw = request.headers["idempotency-key"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === "") return undefined;
  if (value.length > 200) throw new ApiError("invalid_request", "Idempotency-Key is too long");
  return value;
}

/** Fastify replies with a stored answer, unchanged. */
export function replay(reply: FastifyReply, response: StoredResponse): FastifyReply {
  reply.header("Idempotent-Replayed", "true");
  return reply.code(response.status).send(response.body);
}
