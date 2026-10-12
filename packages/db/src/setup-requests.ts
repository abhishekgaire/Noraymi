import type { Queryable } from "./tenancy.js";

/**
 * Requests to our team from Set up your venue (O-10; spec 17 · Step details 8): a menu sent as
 * a PDF or a photo for us to type in. The Console lists the open ones; nothing in the file is
 * read automatically, and nothing reaches the venue's menu until our team types it in.
 */
export interface SetupRequest {
  readonly id: string;
  readonly kind: "menu";
  readonly file_id: string | null;
  readonly note: string | null;
  readonly state: "open" | "done";
  readonly requested_by_name: string | null;
  readonly requested_at: string;
  readonly done_at: string | null;
}

const COLS = `r.id, r.kind, r.file_id, r.note, r.state, u.name as requested_by_name,
  to_json(r.requested_at) #>> '{}' as requested_at, to_json(r.done_at) #>> '{}' as done_at`;

export async function createSetupRequest(
  c: Queryable,
  venueId: string,
  input: { kind: "menu"; fileId: string | null; note: string | null; userId: string },
): Promise<SetupRequest> {
  const r = await c.query<{ id: string }>(
    `insert into setup_requests (venue_id, kind, file_id, note, requested_by)
       values ($1, $2, $3, $4, $5) returning id`,
    [venueId, input.kind, input.fileId, input.note, input.userId],
  );
  return (await listSetupRequests(c, venueId, { id: r.rows[0]!.id }))[0]!;
}

export async function listSetupRequests(
  c: Queryable,
  venueId: string,
  filter: { id?: string; openOnly?: boolean } = {},
): Promise<SetupRequest[]> {
  const r = await c.query<SetupRequest>(
    `select ${COLS} from setup_requests r left join users u on u.id = r.requested_by
      where r.venue_id = $1 and ($2::uuid is null or r.id = $2) and (not $3 or r.state = 'open')
      order by r.requested_at desc, r.id`,
    [venueId, filter.id ?? null, filter.openOnly ?? false],
  );
  return r.rows;
}

/** Our team marks a request done (the Console); false when it isn't open. */
export async function finishSetupRequest(
  c: Queryable,
  venueId: string,
  id: string,
  input: { staffId: string; at: string },
): Promise<boolean> {
  const r = await c.query(
    `update setup_requests set state = 'done', done_by = $3, done_at = $4
      where venue_id = $1 and id = $2 and state = 'open'`,
    [venueId, id, input.staffId, input.at],
  );
  return r.rowCount === 1;
}
