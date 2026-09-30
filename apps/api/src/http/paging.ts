import { ApiError } from "./errors.js";

/** Lists page with a cursor and at most 100 items (spec 08 · Lists). */
export const MAX_PAGE = 100;

export interface ListQuery {
  readonly after?: string | undefined;
  readonly limit: number;
  readonly status?: string | undefined;
  readonly state?: string | undefined;
}

export function parseListQuery(query: Record<string, unknown>): ListQuery {
  const rawLimit = query["limit"];
  let limit = MAX_PAGE;
  if (rawLimit !== undefined) {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n < 1)
      throw new ApiError("invalid_request", "limit must be a whole number from 1 to 100");
    limit = Math.min(n, MAX_PAGE);
  }
  const str = (k: string): string | undefined => {
    const v = query[k];
    return typeof v === "string" && v !== "" ? v : undefined;
  };
  return { after: str("after"), limit, status: str("status"), state: str("state") };
}

export interface Page<T> {
  readonly items: T[];
  /** Pass back as ?after= for the next page; null on the last page. */
  readonly next_cursor: string | null;
}

/**
 * Cut a list fetched with limit + 1 rows down to one page. The cursor is the
 * last item's sort key, so a query "where key > $after order by key" continues.
 */
export function page<T>(rows: readonly T[], limit: number, cursorOf: (item: T) => string): Page<T> {
  const items = rows.slice(0, limit);
  const more = rows.length > limit;
  const last = items[items.length - 1];
  return { items, next_cursor: more && last !== undefined ? cursorOf(last) : null };
}
