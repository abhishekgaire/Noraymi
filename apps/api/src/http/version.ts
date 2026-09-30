import type { FastifyRequest } from "fastify";
import { ApiError } from "./errors.js";

/**
 * Optimistic concurrency (spec 08 · Conflicts): a check carries `version`,
 * an edit sends If-Match, and 409 version_conflict answers when someone else
 * changed it first.
 */
export function ifMatch(request: FastifyRequest): number | undefined {
  const raw = request.headers["if-match"];
  if (raw === undefined) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(String(value).replace(/^W\//, "").replace(/"/g, ""));
  if (!Number.isInteger(n) || n < 0)
    throw new ApiError("invalid_request", "If-Match must be a version number");
  return n;
}

export function assertVersion(
  current: number,
  expected: number | undefined,
  what = "this record",
): void {
  if (expected === undefined)
    throw new ApiError("invalid_request", `If-Match is required to change ${what}`);
  if (current !== expected) {
    throw new ApiError(
      "version_conflict",
      `${what} changed since you loaded it (version ${current})`,
      {
        details: { version: current },
      },
    );
  }
}
