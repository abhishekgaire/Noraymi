/**
 * The desktop app's read-only offline view (M8-03; spec 09 · Offline and
 * queue mode, spec 12 · 6). Only these reads are kept in the encrypted cache:
 * the board, the sessions and bookings behind it, open tabs and each open
 * check's lines, the menu with its 86'd items, the room orders at the bar, and
 * what the bar POS needs to draw itself. Nothing else is cached, and nothing
 * is written: the cloud stays the only writer.
 */
const VENUE = "/v1/venues/[A-Za-z0-9-]{1,64}/";
const ID = "[A-Za-z0-9-]{1,64}";
const ORDER_STATUSES = "(ringing|held|accepted|ready|on_the_way|delivered|returned|cancelled)";

const OFFLINE_READS: readonly RegExp[] = [
  new RegExp(`^${VENUE}(board|sessions|bookings|tabs|menu)$`),
  new RegExp(`^${VENUE}pos/layouts\\?station=bar$`),
  new RegExp(`^${VENUE}pos/terminal$`),
  new RegExp(`^${VENUE}print-jobs\\?status=failed$`),
  new RegExp(
    `^${VENUE}orders\\?status=${ORDER_STATUSES}(,${ORDER_STATUSES}){0,7}(&business_date=\\d{4}-\\d{2}-\\d{2})?$`,
  ),
  new RegExp(`^${VENUE}checks/${ID}$`),
  // The team's names and roles (no PIN hashes): queue mode's "who's ringing it" (M8-04).
  new RegExp(`^${VENUE}team/tiles$`),
];

/** The longest answer kept for one read (the board of a large venue stays well under it). */
export const OFFLINE_MAX_BYTES = 2_000_000;

/** True when this GET is one the offline view keeps. */
export function isOfflineRead(path: string): boolean {
  return path.length <= 300 && OFFLINE_READS.some((r) => r.test(path));
}

/** One kept read: the answer, and the venue time it was synced at. */
export interface OfflineSnapshot<T = unknown> {
  readonly synced_at: string;
  readonly body: T;
}

/** The reads the desktop app keeps fresh for the bar and front desk, whichever screen is open. */
export function offlinePrefetchPaths(venueId: string, businessDate: string | null): string[] {
  const v = `/v1/venues/${venueId}`;
  return [
    `${v}/board`,
    `${v}/sessions`,
    `${v}/bookings`,
    `${v}/tabs`,
    `${v}/menu`,
    `${v}/pos/layouts?station=bar`,
    `${v}/pos/terminal`,
    `${v}/print-jobs?status=failed`,
    `${v}/orders?status=ringing,held`,
    ...(businessDate
      ? [
          `${v}/orders?status=ringing,held,accepted,ready,on_the_way,delivered,returned,cancelled&business_date=${businessDate}`,
        ]
      : []),
  ];
}
