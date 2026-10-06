import type pg from "pg";
import { recordVendorCall, withVenue, type Vendor } from "@west4/db";
import type { Clock } from "@west4/shared";

/**
 * Our own error rate on calls to Stripe and Twilio (M8-01; spec 09 ·
 * Outages). The Stripe and Twilio clients report each call's outcome here:
 * "failed" means the vendor didn't answer, timed out, answered 5xx or
 * throttled us (429). A decline or a bad number is an answer, not trouble.
 * The API and the worker install an observer that counts the call against
 * the venue (or venues) behind the account; tests and scripts install none.
 */
export type VendorObserver = (vendor: Vendor, account: string, failed: boolean) => void;

let observer: VendorObserver | null = null;

export function setVendorObserver(next: VendorObserver | null): void {
  observer = next;
}

/** Called by the clients after every call that reached (or tried to reach) the vendor. */
export function noteVendorCall(vendor: Vendor, account: string | null, failed: boolean): void {
  if (!observer || !account) return;
  try {
    observer(vendor, account, failed);
  } catch {
    // Counting never breaks a payment or a text.
  }
}

/**
 * The observer the API and the worker install: finds the venues behind the
 * account (resolve_stripe_account, resolve_twilio_account) and adds the call
 * to each one's minute. Fire and forget, after the call, outside any
 * transaction; a failure to count is dropped.
 */
export function databaseVendorObserver(
  pool: pg.Pool,
  clock: Clock & { refresh?: () => Promise<void> },
): VendorObserver {
  return (vendor, account, failed) => {
    void (async () => {
      // The venue's clock (the simulated one in staging), as the vendor-health job reads it.
      await clock.refresh?.();
      const at = clock.now().toString();
      const resolved = await pool.query<{ venue_id: string | null }>(
        vendor === "stripe"
          ? "select resolve_stripe_account($1) as venue_id"
          : "select resolve_twilio_account($1) as venue_id",
        [account],
      );
      for (const row of resolved.rows) {
        if (!row.venue_id) continue;
        await withVenue(pool, { venueId: row.venue_id, requestId: "vendor-calls" }, (c) =>
          recordVendorCall(c, row.venue_id!, vendor, at, failed),
        );
      }
    })().catch(() => {});
  };
}
