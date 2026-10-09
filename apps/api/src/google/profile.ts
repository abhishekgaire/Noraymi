import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  decryptSecret,
  enqueue,
  listClosures,
  readSetting,
  type JobHandler,
  type Queryable,
} from "@west4/db";
import { businessDate, googleHours } from "@west4/rules";
import { Temporal } from "@west4/shared";
import { GoogleError, type GoogleClient } from "./client.js";

/**
 * Google Business Profile (M5-15; spec 03 · `hours`): the venue's
 * `integrations` row (kind google) and the job that pushes the weekly hours
 * and every closure to the connected location.
 *
 * The row: status pending (Google said yes, no location picked yet),
 * connected (external_id is the location, `locations/…`) or disconnected.
 * config holds the refresh token encrypted (`refresh_enc`), the location's
 * title and the last push (`last_push`: ok or failed, when, Google's error).
 */
export const GOOGLE_PUSH_KIND = "google.hours";
const MAX_ATTEMPTS = 8;

export interface GoogleRow {
  readonly status: "pending" | "connected" | "disconnected" | "error";
  readonly external_id: string | null;
  readonly config: {
    readonly refresh_enc?: string;
    readonly location_title?: string;
    readonly last_push?: LastPush;
  };
  readonly connected_at: string | null;
}

export interface LastPush {
  readonly status: "ok" | "failed";
  readonly at: string;
  readonly error?: string;
}

export async function googleRow(c: Queryable, venueId: string): Promise<GoogleRow | null> {
  const r = await c.query<GoogleRow>(
    `select status, external_id, config, to_json(connected_at) #>> '{}' as connected_at
       from integrations where venue_id = $1 and kind = 'google'`,
    [venueId],
  );
  return r.rows[0] ?? null;
}

/** Google's answer to the venue's consent: the refresh token, kept encrypted; no location yet. */
export async function saveGoogleConsent(
  c: Queryable,
  venueId: string,
  refreshEnc: string,
): Promise<void> {
  await c.query(
    `insert into integrations (venue_id, kind, status, external_id, config)
     values ($1, 'google', 'pending', null, jsonb_build_object('refresh_enc', $2::text))
     on conflict (venue_id, kind) do update
       set status = 'pending', external_id = null, connected_at = null,
           config = jsonb_build_object('refresh_enc', $2::text)`,
    [venueId, refreshEnc],
  );
}

export async function connectLocation(
  c: Queryable,
  venueId: string,
  location: { name: string; title: string },
  now: Temporal.Instant,
): Promise<void> {
  await c.query(
    `update integrations
        set status = 'connected', external_id = $2, connected_at = $4,
            config = (config - 'last_push') || jsonb_build_object('location_title', $3::text)
      where venue_id = $1 and kind = 'google'`,
    [venueId, location.name, location.title, new Date(now.epochMilliseconds)],
  );
}

/** Off: the token is dropped and nothing pushes; reconnecting starts at Google's consent again. */
export async function disconnectGoogle(c: Queryable, venueId: string): Promise<boolean> {
  const r = await c.query(
    `update integrations set status = 'disconnected', external_id = null, connected_at = null,
            config = '{}'::jsonb
      where venue_id = $1 and kind = 'google' and status <> 'disconnected'`,
    [venueId],
  );
  return (r.rowCount ?? 0) > 0;
}

async function recordPush(c: Queryable, venueId: string, push: LastPush): Promise<void> {
  await c.query(
    `update integrations set config = config || jsonb_build_object('last_push', $2::jsonb)
      where venue_id = $1 and kind = 'google'`,
    [venueId, JSON.stringify(push)],
  );
}

/**
 * Queue a push in the same transaction as the change (an hours save, a
 * closure, a new connection). Nothing is queued while Google isn't
 * connected. `at` delays it, for hours that start on a later business date.
 */
export async function queueGooglePush(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
  at?: Temporal.Instant,
): Promise<string | null> {
  const row = await googleRow(c, venueId);
  if (row?.status !== "connected" || !row.external_id) return null;
  const runAt = at && Temporal.Instant.compare(at, now) > 0 ? at : now;
  return enqueue(c, {
    venueId,
    kind: GOOGLE_PUSH_KIND,
    pool: "normal",
    runAt,
    maxAttempts: MAX_ATTEMPTS,
  });
}

/**
 * The push: read the location, the hours in force and the closures from
 * today on in one short step; send the whole schedule to Google outside any
 * transaction; keep the outcome for Admin. A failure is recorded, then thrown
 * so the worker retries it with backoff.
 */
export function makeGooglePushHandler(google: GoogleClient, secretKey: Buffer): JobHandler {
  return async (job) => {
    const venueId = job.job.venue_id;
    const now = job.clock.now();
    const read = await job.step(async (c) => {
      const row = await googleRow(c, venueId);
      const venue = (
        await c.query<{ time_zone: string; day_cutover: string }>(
          "select time_zone, to_char(day_cutover, 'HH24:MI') as day_cutover from venues where id = $1",
          [venueId],
        )
      ).rows[0]!;
      const today = Temporal.PlainDate.from(
        businessDate(now, venue.time_zone, venue.day_cutover).businessDate,
      );
      const hours = await readSetting(c, venueId, "hours", today);
      const closures = await listClosures(c, venueId, { from: today.toString(), limit: 1000 });
      return { row, venue, today, hours, closures };
    });
    const { row } = read;
    // Nothing pushes while the connection is off, and no hours are made up when none are set.
    if (row?.status !== "connected" || !row.external_id || !row.config.refresh_enc) return;
    if (!read.hours) return;
    const body = googleHours(read.hours.value, read.closures, read.today, read.venue.day_cutover);
    try {
      const token = await google.accessToken(decryptSecret(secretKey, row.config.refresh_enc));
      await google.patchHours(token, row.external_id, body);
    } catch (e) {
      const error = e instanceof GoogleError ? e.message : "the push failed";
      await job.step((c) =>
        recordPush(c, venueId, { status: "failed", at: now.toString(), error }),
      );
      throw e;
    }
    await job.step((c) => recordPush(c, venueId, { status: "ok", at: now.toString() }));
  };
}

/** The OAuth state: the venue, the person and an expiry, signed, so a callback can't be replayed elsewhere. */
export function signState(
  key: Buffer,
  venueId: string,
  userId: string,
  expires: Temporal.Instant,
): string {
  const payload = Buffer.from(
    JSON.stringify({
      v: venueId,
      u: userId,
      e: expires.epochMilliseconds,
      n: randomBytes(8).toString("hex"),
    }),
  ).toString("base64url");
  return `${payload}.${mac(key, payload)}`;
}

export function checkState(
  key: Buffer,
  state: string,
  venueId: string,
  userId: string,
  now: Temporal.Instant,
): boolean {
  const [payload, sig] = state.split(".");
  if (!payload || !sig) return false;
  const want = Buffer.from(mac(key, payload));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      v: string;
      u: string;
      e: number;
    };
    return p.v === venueId && p.u === userId && p.e > now.epochMilliseconds;
  } catch {
    return false;
  }
}

const mac = (key: Buffer, payload: string) =>
  createHmac("sha256", key).update(`google-oauth:${payload}`).digest("base64url");
