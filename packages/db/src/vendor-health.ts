import type { Queryable } from "./tenancy.js";
import { emitEvent } from "./events.js";

/**
 * Vendor health (M8-01; spec 09 · Outages). Our own calls to Stripe and
 * Twilio are counted per venue and per minute; the vendor-health job reads
 * them with the vendors' status feeds and sets one state per venue and
 * vendor. A change raises vendor.health on the venue's channel, and every
 * staff screen refetches the venue's connection.
 */
export type Vendor = "stripe" | "twilio";
export const VENDORS: readonly Vendor[] = ["stripe", "twilio"];
export type VendorTroubleSource = "status_feed" | "venue_errors" | "overall_errors";

export interface VendorCallCount {
  readonly vendor: Vendor;
  readonly calls: number;
  readonly errors: number;
}

/** One call's outcome, added to its minute (the venue's clock). Outside any money transaction. */
export async function recordVendorCall(
  c: Queryable,
  venueId: string,
  vendor: Vendor,
  at: string,
  failed: boolean,
): Promise<void> {
  await c.query(
    `insert into vendor_calls (venue_id, vendor, minute, calls, errors)
     values ($1, $2, date_trunc('minute', $3::timestamptz), 1, $4)
     on conflict (venue_id, vendor, minute)
     do update set calls = vendor_calls.calls + 1, errors = vendor_calls.errors + excluded.errors`,
    [venueId, vendor, at, failed ? 1 : 0],
  );
}

const counts = (rows: { vendor: string; calls: string | number; errors: string | number }[]) =>
  VENDORS.map((vendor) => {
    const row = rows.find((r) => r.vendor === vendor);
    return { vendor, calls: Number(row?.calls ?? 0), errors: Number(row?.errors ?? 0) };
  });

/** This venue's calls since a time, per vendor. */
export async function venueVendorCalls(
  c: Queryable,
  venueId: string,
  since: string,
): Promise<VendorCallCount[]> {
  const r = await c.query<{ vendor: string; calls: string; errors: string }>(
    `select vendor, sum(calls) as calls, sum(errors) as errors from vendor_calls
      where venue_id = $1 and minute >= $2 group by vendor`,
    [venueId, since],
  );
  return counts(r.rows);
}

/** Every venue's calls together since a time (counts only; no venue is named). */
export async function overallVendorCalls(c: Queryable, since: string): Promise<VendorCallCount[]> {
  const r = await c.query<{ vendor: string; calls: string; errors: string }>(
    "select vendor, calls, errors from vendor_call_totals($1)",
    [since],
  );
  return counts(r.rows);
}

export interface VendorHealthRow {
  readonly vendor: Vendor;
  readonly trouble: boolean;
  readonly source: VendorTroubleSource | null;
  readonly since: string | null;
}

export async function venueVendorHealth(
  c: Queryable,
  venueId: string,
): Promise<Record<Vendor, VendorHealthRow>> {
  const r = await c.query<{
    vendor: Vendor;
    trouble: boolean;
    source: VendorTroubleSource | null;
    since: string | null;
  }>("select vendor, trouble, source, since::text from vendor_health where venue_id = $1", [
    venueId,
  ]);
  const out = {} as Record<Vendor, VendorHealthRow>;
  for (const vendor of VENDORS)
    out[vendor] = r.rows.find((row) => row.vendor === vendor) ?? {
      vendor,
      trouble: false,
      source: null,
      since: null,
    };
  return out;
}

/**
 * Set one vendor's state for a venue; raises vendor.health only when trouble
 * starts or ends. Returns whether it changed.
 */
export async function setVendorHealth(
  c: Queryable,
  venueId: string,
  vendor: Vendor,
  verdict: { trouble: boolean; source: VendorTroubleSource | null },
  now: string,
): Promise<boolean> {
  const before = await c.query<{ trouble: boolean }>(
    "select trouble from vendor_health where venue_id = $1 and vendor = $2 for update",
    [venueId, vendor],
  );
  const was = before.rows[0]?.trouble ?? false;
  const changed = was !== verdict.trouble;
  if (before.rows.length === 0)
    await c.query(
      `insert into vendor_health (venue_id, vendor, trouble, source, since, checked_at)
       values ($1, $2, $3, $4, case when $3 then $5::timestamptz end, $5)`,
      [venueId, vendor, verdict.trouble, verdict.source, now],
    );
  else if (changed)
    await c.query(
      `update vendor_health set trouble = $3, source = $4,
              since = case when $3 then $5::timestamptz end, checked_at = $5
        where venue_id = $1 and vendor = $2`,
      [venueId, vendor, verdict.trouble, verdict.source, now],
    );
  else
    await c.query(
      "update vendor_health set checked_at = $3, source = $4 where venue_id = $1 and vendor = $2",
      [venueId, vendor, now, verdict.source],
    );
  if (changed) await emitEvent(c, { venueId, type: "vendor.health", entityId: venueId });
  return changed;
}

/** True while the venue's dual-WAN router reports it's on LTE (M8-02 feeds the router's heartbeat). */
export async function venueOnBackupInternet(c: Queryable, venueId: string): Promise<boolean> {
  const r = await c.query<{ on_backup: boolean }>(
    `select coalesce(bool_or((h.network ->> 'on_backup_now')::boolean), false) as on_backup
       from devices d join device_heartbeats h on h.venue_id = d.venue_id and h.device_id = d.id
      where d.venue_id = $1 and d.kind = 'router' and d.revoked_at is null and not d.sandbox
        and h.offline_since is null`,
    [venueId],
  );
  return r.rows[0]?.on_backup ?? false;
}
