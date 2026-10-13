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
  printer: {
    deviceId: string;
    station: string;
    now: string;
    /** A relayed network printer (W-04) takes only jobs nobody was sent, so none prints twice. */
    onlyQueued?: boolean;
  },
): Promise<PrintJobRow | null> {
  const r = await c.query<PrintJobRow>(
    `update print_jobs set device_id = $2, status = 'sent', sent_at = coalesce(sent_at, $4)
      where id = (
        select id from print_jobs
         where venue_id = $1 and confirmed_at is null
           and (status = 'queued' or (status = 'sent' and not $5::boolean))
           and (device_id = $2 or (device_id is null and station = $3))
         order by created_at, id limit 1 for update skip locked)
      returning ${COLS}`,
    [venueId, printer.deviceId, printer.station, printer.now, printer.onlyQueued === true],
  );
  return r.rows[0] ?? null;
}

/** A network printer a relay holds the lease on (W-04). */
export interface RelayedPrinter {
  readonly id: string;
  readonly network_address: string;
  readonly network_port: number;
  readonly station: string;
  readonly command_set: string | null;
}

/**
 * The network printers this desktop app computer may relay, leased to it until `until` (W-04;
 * D127): those naming it, or with no names when it is a bar computer, and held by nobody else
 * whose lease still runs. A second relay asking meanwhile gets none of them, so each job goes to
 * one computer; a relay that stops asking loses them when its lease runs out.
 */
export async function leaseRelayPrinters(
  c: Queryable,
  venueId: string,
  host: { deviceId: string; kind: string },
  now: string,
  until: string,
): Promise<RelayedPrinter[]> {
  const r = await c.query<RelayedPrinter>(
    `update devices p set relay_host_id = $2, relay_until = $5
      where p.venue_id = $1 and p.kind = 'printer' and p.protocol = 'lan'
        and p.revoked_at is null and p.disabled_at is null
        and ((p.relay_device_ids is null and $3 = 'bar_computer') or $2 = any(p.relay_device_ids))
        and (p.relay_host_id is null or p.relay_host_id = $2 or p.relay_until < $4)
      returning p.id, p.network_address, p.network_port, coalesce(p.station, 'kitchen') as station,
                p.command_set`,
    [venueId, host.deviceId, host.kind, now, until],
  );
  return [...r.rows].sort((a, b) => a.id.localeCompare(b.id));
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
