import type { Queryable } from "./tenancy.js";

export interface ClosureRow {
  readonly id: string;
  readonly date: string;
  readonly kind: "closed" | "special";
  readonly opens: string | null;
  readonly closes: string | null;
  readonly note: string | null;
  readonly created_at: string;
}

const COLS =
  "id, date::text, kind, to_char(opens, 'HH24:MI') as opens, to_char(closes, 'HH24:MI') as closes, note, created_at::text";

/** Closures from a date on, in date order, `limit + 1` rows for paging. Inside a venue transaction. */
export async function listClosures(
  client: Queryable,
  venueId: string,
  args: {
    after?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    limit: number;
  },
): Promise<ClosureRow[]> {
  const r = await client.query<ClosureRow>(
    `select ${COLS} from closures
      where venue_id = $1 and ($2::date is null or date > $2::date) and ($3::date is null or date >= $3::date) and ($4::date is null or date <= $4::date)
      order by date limit $5`,
    [venueId, args.after ?? null, args.from ?? null, args.to ?? null, args.limit + 1],
  );
  return r.rows;
}

export async function closureOn(
  client: Queryable,
  venueId: string,
  date: string,
): Promise<ClosureRow | null> {
  const r = await client.query<ClosureRow>(
    `select ${COLS} from closures where venue_id = $1 and date = $2`,
    [venueId, date],
  );
  return r.rows[0] ?? null;
}

export class ClosureExists extends Error {
  constructor(readonly date: string) {
    super(`a closure for ${date} exists already`);
    this.name = "ClosureExists";
  }
}

export async function createClosure(
  client: Queryable,
  args: {
    venueId: string;
    date: string;
    kind: "closed" | "special";
    opens?: string | null;
    closes?: string | null;
    note?: string | null;
    createdBy?: string | undefined;
  },
): Promise<ClosureRow> {
  const r = await client.query<ClosureRow>(
    `insert into closures (venue_id, date, kind, opens, closes, note, created_by)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (venue_id, date) do nothing
     returning ${COLS}`,
    [
      args.venueId,
      args.date,
      args.kind,
      args.opens ?? null,
      args.closes ?? null,
      args.note ?? null,
      args.createdBy ?? null,
    ],
  );
  if (!r.rows[0]) throw new ClosureExists(args.date);
  return r.rows[0];
}
