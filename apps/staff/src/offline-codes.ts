import { Temporal } from "@west4/shared";
import { api } from "./api.js";

/**
 * Offline codes on a manager's phone (M8-04; spec 09 · Offline and queue
 * mode). While online the phone fetches each paired computer's next 12 hours
 * of codes and keeps them on the phone, so a code can still be read out
 * when our cloud is down. Managers' and owners' phones only: the API refuses
 * everyone else.
 */
export interface DeviceCodes {
  readonly device_id: string;
  readonly name: string;
  readonly kind: string;
  readonly codes: readonly { starts_at: string; ends_at: string; code: string }[];
}

export interface KeptCodes {
  readonly fetched_at: string;
  readonly devices: readonly DeviceCodes[];
}

/** How often a manager's phone refreshes the codes it keeps, while online. */
export const OFFLINE_CODES_REFRESH_MS = 30 * 60_000;

const key = (venueId: string) => `west4.offlineCodes.${venueId}`;

export function keptCodes(venueId: string): KeptCodes | null {
  try {
    const raw = localStorage.getItem(key(venueId));
    return raw ? (JSON.parse(raw) as KeptCodes) : null;
  } catch {
    return null;
  }
}

/** Fetch the codes and keep them; the kept ones stay when the fetch fails. */
export async function fetchAndKeepCodes(venueId: string): Promise<KeptCodes> {
  const answer = await api<{ devices: DeviceCodes[]; server_time: string }>(
    "GET",
    `/v1/venues/${venueId}/offline-codes`,
  );
  const kept: KeptCodes = { fetched_at: answer.server_time, devices: answer.devices };
  try {
    localStorage.setItem(key(venueId), JSON.stringify(kept));
  } catch {
    // Private mode or a full store: the screen still shows what it fetched.
  }
  return kept;
}

/** The code a computer shows right now, and when it changes, or null once the kept ones have run out. */
export function codeNow(
  device: DeviceCodes,
  now: Temporal.Instant,
): { code: string; ends_at: string } | null {
  const at = now.epochMilliseconds;
  const hit = device.codes.find(
    (c) =>
      Temporal.Instant.from(c.starts_at).epochMilliseconds <= at &&
      at < Temporal.Instant.from(c.ends_at).epochMilliseconds,
  );
  return hit ? { code: hit.code, ends_at: hit.ends_at } : null;
}
