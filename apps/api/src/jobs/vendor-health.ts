import type pg from "pg";
import {
  VENDORS,
  overallVendorCalls,
  setVendorHealth,
  venueVendorCalls,
  withVenue,
  type Sweep,
  type Vendor,
  type VendorCallCount,
  type VendorTroubleSource,
} from "@west4/db";
import type { Temporal } from "@west4/shared";

/**
 * Vendor-health checks (M8-01; spec 09 · Outages, spec 01 · When our cloud
 * is down). Every 30 seconds: Stripe's and Twilio's published status feeds
 * (fetched outside any transaction), our own error rate on calls to each
 * vendor for the venue, and the same rate over every venue together. Any one
 * of them in trouble puts the vendor in trouble for the venue, which raises
 * vendor.health, and the staff screens show "Stripe is having trouble · card
 * payments may fail" or "Texts are delayed". The CDN has no staff banner
 * until its wording is set (the ticket's cautious default), so it isn't checked.
 */
export const VENDOR_HEALTH_EVERY_MS = 30_000;

export interface VendorHealthSettings {
  /** A Statuspage-style JSON feed ({ status: { indicator } }); null: the feed isn't read. */
  readonly statusUrls: Readonly<Record<Vendor, string | null>>;
  /** The error-rate window, in minutes of the venue's clock. */
  readonly windowMinutes: number;
  /** Fewer calls than this in the window say nothing either way. */
  readonly minCalls: number;
  /** Trouble at or over this share of failed calls, in whole percent. */
  readonly ratePercent: number;
}

const positive = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/**
 * Cautious defaults (the spec sets no threshold): 20% of at least 5 calls in
 * 5 minutes. Platform settings, the same for every venue, from the environment.
 */
export function loadVendorHealthSettings(
  source: Record<string, string | undefined> = process.env,
): VendorHealthSettings {
  const url = (key: string) => {
    const value = source[key]?.trim();
    return value ? value : null;
  };
  return {
    statusUrls: { stripe: url("STRIPE_STATUS_URL"), twilio: url("TWILIO_STATUS_URL") },
    windowMinutes: positive(source["VENDOR_ERROR_WINDOW_MINUTES"], 5),
    minCalls: positive(source["VENDOR_ERROR_MIN_CALLS"], 5),
    ratePercent: Math.min(100, positive(source["VENDOR_ERROR_RATE_PERCENT"], 20)),
  };
}

/** Over the threshold: integer arithmetic, no float. */
export function overThreshold(
  count: Pick<VendorCallCount, "calls" | "errors">,
  settings: Pick<VendorHealthSettings, "minCalls" | "ratePercent">,
): boolean {
  return (
    count.calls >= settings.minCalls && count.errors * 100 >= count.calls * settings.ratePercent
  );
}

/** One vendor's state for one venue: the feed first, then the venue's own calls, then everyone's. */
export function vendorVerdict(
  input: {
    readonly feedTrouble: boolean | null;
    readonly venue: Pick<VendorCallCount, "calls" | "errors">;
    readonly overall: Pick<VendorCallCount, "calls" | "errors">;
  },
  settings: Pick<VendorHealthSettings, "minCalls" | "ratePercent">,
): { trouble: boolean; source: VendorTroubleSource | null } {
  if (input.feedTrouble === true) return { trouble: true, source: "status_feed" };
  if (overThreshold(input.venue, settings)) return { trouble: true, source: "venue_errors" };
  if (overThreshold(input.overall, settings)) return { trouble: true, source: "overall_errors" };
  return { trouble: false, source: null };
}

/**
 * A Statuspage feed's verdict: a major or critical indicator is trouble; none
 * or minor isn't (a minor incident is often a part of the vendor we don't
 * use). No answer, or one we can't read, says nothing (null).
 */
export async function readStatusFeed(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean | null> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return null;
    const body = (await response.json()) as { status?: { indicator?: unknown } };
    const indicator = body.status?.indicator;
    if (typeof indicator !== "string") return null;
    return indicator === "major" || indicator === "critical";
  } catch {
    return null;
  }
}

export async function sweepVendorHealth(
  pool: pg.Pool,
  now: Temporal.Instant,
  settings: VendorHealthSettings = loadVendorHealthSettings(),
  fetchImpl: typeof fetch = fetch,
  log?: (line: string) => void,
): Promise<{ venueId: string; changed: Vendor[] }[]> {
  // The feeds first, outside any transaction.
  const feeds = {} as Record<Vendor, boolean | null>;
  for (const vendor of VENDORS) {
    const url = settings.statusUrls[vendor];
    feeds[vendor] = url ? await readStatusFeed(url, fetchImpl) : null;
  }
  const since = now.subtract({ minutes: settings.windowMinutes }).toString();
  const overall = await overallVendorCalls(pool, since);
  const venues = await pool.query<{ id: string }>("select id from venues_for_scheduler()");
  const out: { venueId: string; changed: Vendor[] }[] = [];
  for (const v of venues.rows) {
    const changed = await withVenue(
      pool,
      { venueId: v.id, requestId: "vendor-health" },
      async (c) => {
        const mine = await venueVendorCalls(c, v.id, since);
        const flipped: Vendor[] = [];
        for (const vendor of VENDORS) {
          const verdict = vendorVerdict(
            {
              feedTrouble: feeds[vendor],
              venue: mine.find((m) => m.vendor === vendor)!,
              overall: overall.find((m) => m.vendor === vendor)!,
            },
            settings,
          );
          if (await setVendorHealth(c, v.id, vendor, verdict, now.toString())) flipped.push(vendor);
        }
        return flipped;
      },
    );
    for (const vendor of changed) log?.(`vendor health: ${vendor} changed for venue ${v.id}`);
    out.push({ venueId: v.id, changed });
  }
  return out;
}

export function vendorHealthSweep(pool: pg.Pool, log?: (line: string) => void): Sweep {
  const settings = loadVendorHealthSettings();
  return {
    name: "vendors.health",
    everyMs: VENDOR_HEALTH_EVERY_MS,
    run: async (now) => void (await sweepVendorHealth(pool, now, settings, fetch, log)),
  };
}
