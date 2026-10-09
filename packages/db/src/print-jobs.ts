import type { Queryable } from "./tenancy.js";

/**
 * Print jobs (M3-13). A printer takes the oldest job for its station that
 * nobody has printed, or one made for it alone (a test ticket); the job id is
 * its CloudPRNT job token. A job not confirmed in time is marked failed, and a
 * reprint is a new job pointing at the first one, numbered 2, 3 and so on.
 */
export interface PrintJobRow {
  readonly id: string;
  readonly kind: string;
  readonly station: string;
  readonly payload: Record<string, unknown>;
  readonly status: string;
  readonly reprint_of: string | null;
  readonly reprint_n: number;
  readonly order_id: string | null;
  readonly device_id: string | null;
}

const COLS = "id, kind, station, payload, status, reprint_of, reprint_n, order_id, device_id";

export async function resolvePrinter(
  c: Queryable,
  deviceId: string,
  secretHash: string,
): Promise<{ venueId: string; station: string; protocol: string } | null> {
  const r = await c.query<{ venue_id: string; station: string; protocol: string }>(
    "select venue_id, station, protocol from resolve_printer($1, $2)",
    [deviceId, secretHash],
  );
  const row = r.rows[0];
  return row ? { venueId: row.venue_id, station: row.station, protocol: row.protocol } : null;
}

/** The next job for a printer: already sent to it and not confirmed, else the oldest queued one for its station. */
export async function claimPrintJob(
  c: Queryable,
  venueId: string,
  printer: { deviceId: string; station: string; now: string },
): Promise<PrintJobRow | null> {
  const r = await c.query<PrintJobRow>(
    `update print_jobs set device_id = $2, status = 'sent', sent_at = coalesce(sent_at, $4)
      where id = (
        select id from print_jobs
         where venue_id = $1 and status in ('queued', 'sent') and confirmed_at is null
           and (device_id = $2 or (device_id is null and station = $3))
         order by created_at, id limit 1 for update skip locked)
      returning ${COLS}`,
    [venueId, printer.deviceId, printer.station, printer.now],
  );
  return r.rows[0] ?? null;
}

/** A job the printer itself was sent, for fetching its content or confirming it. */
export async function printerJob(
  c: Queryable,
  venueId: string,
  deviceId: string,
  jobId: string,
): Promise<PrintJobRow | null> {
  const r = await c.query<PrintJobRow>(
    `select ${COLS} from print_jobs where venue_id = $1 and id = $2 and device_id = $3`,
    [venueId, jobId, deviceId],
  );
  return r.rows[0] ?? null;
}

/** The printer's word on a job: printed, or failed with its reason. Returns the job, or null if it isn't the printer's. */
export async function settlePrintJob(
  c: Queryable,
  venueId: string,
  deviceId: string,
  jobId: string,
  outcome: { printed: boolean; failure?: string | null; now: string },
): Promise<PrintJobRow | null> {
  const r = await c.query<PrintJobRow>(
    outcome.printed
      ? `update print_jobs set status = 'printed', confirmed_at = $4
          where venue_id = $1 and id = $2 and device_id = $3 returning ${COLS}`
      : `update print_jobs set status = 'failed', failed_at = $4, failure = $5
          where venue_id = $1 and id = $2 and device_id = $3 and confirmed_at is null returning ${COLS}`,
    outcome.printed
      ? [venueId, jobId, deviceId, outcome.now]
      : [venueId, jobId, deviceId, outcome.now, outcome.failure ?? "the printer reported an error"],
  );
  return r.rows[0] ?? null;
}

/** Jobs made before the cutoff and still not confirmed: failed. */
export async function failStalePrintJobs(
  c: Queryable,
  venueId: string,
  cutoff: string,
  now: string,
): Promise<PrintJobRow[]> {
  const r = await c.query<PrintJobRow>(
    `update print_jobs set status = 'failed', failed_at = $3,
            failure = coalesce(failure, 'not confirmed after three polls')
      where venue_id = $1 and status in ('queued', 'sent') and confirmed_at is null and created_at < $2
      returning ${COLS}`,
    [venueId, cutoff, now],
  );
  return r.rows;
}

/**
 * A reprint: a new job with the first job's content, numbered after the last reprint. `station`
 * sends it to another station's printer: a kitchen ticket printed at the bar instead (K-03). Without
 * it, a kitchen ticket goes back to the kitchen, even when the copy before was printed at the bar.
 */
export async function reprintJob(
  c: Queryable,
  venueId: string,
  jobId: string,
  now: string,
  station?: string,
): Promise<{ id: string; reprint_n: number } | null> {
  const job = await c.query<PrintJobRow & { check_id: string | null }>(
    `select ${COLS}, check_id from print_jobs where venue_id = $1 and id = $2`,
    [venueId, jobId],
  );
  const j = job.rows[0];
  if (!j) return null;
  const root = j.reprint_of ?? j.id;
  const last = await c.query<{ n: number }>(
    "select coalesce(max(reprint_n), 1)::int as n from print_jobs where venue_id = $1 and (id = $2 or reprint_of = $2)",
    [venueId, root],
  );
  const n = Math.max(1, last.rows[0]!.n) + 1;
  const r = await c.query<{ id: string }>(
    `insert into print_jobs (venue_id, order_id, check_id, kind, station, payload, reprint_of, reprint_n, created_at, device_id)
     select venue_id, order_id, check_id, kind, coalesce($6, case when payload->>'kitchen' = 'true' then 'kitchen' else station end), payload, $3, $4, $5,
            case when payload ? 'test' and $6::text is null then device_id end
       from print_jobs where venue_id = $1 and id = $2
     returning id`,
    [venueId, jobId, root, n, now, station ?? null],
  );
  return { id: r.rows[0]!.id, reprint_n: n };
}

export interface FailedTicket {
  readonly id: string;
  readonly order_id: string | null;
  readonly room_name: string | null;
  readonly station: string;
  /** A kitchen ticket (K-03), wherever it was sent: "Kitchen ticket didn't print · Reprint". */
  readonly kitchen: boolean;
  readonly reprint_n: number;
  readonly failed_at: string;
}

/** Tickets that didn't print and haven't been reprinted since: "Ticket didn't print · Reprint". */
export async function failedTickets(
  c: Queryable,
  venueId: string,
  now: string,
): Promise<FailedTicket[]> {
  const r = await c.query<FailedTicket>(
    `select j.id, j.order_id, coalesce(r.name, j.payload->>'room') as room_name, j.station,
            coalesce((j.payload->>'kitchen')::boolean, false) as kitchen, j.reprint_n,
            to_json(j.failed_at) #>> '{}' as failed_at
       from print_jobs j
       left join orders o on o.venue_id = j.venue_id and o.id = j.order_id
       left join room_sessions s on s.venue_id = o.venue_id and s.id = o.session_id
       left join rooms r on r.venue_id = s.venue_id and r.id = s.room_id
      where j.venue_id = $1 and j.status = 'failed' and j.failed_at > $2::timestamptz - interval '12 hours'
        and not exists (
          select 1 from print_jobs later
           where later.venue_id = j.venue_id and later.reprint_of = coalesce(j.reprint_of, j.id)
             and later.created_at > j.created_at)
      order by j.failed_at`,
    [venueId, now],
  );
  return r.rows;
}
