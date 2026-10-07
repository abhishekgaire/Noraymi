import { Temporal } from "@west4/shared";
import { businessDate } from "./time.js";

/**
 * Offline codes (M8-04; spec 09 · Offline and queue mode). The desktop app
 * checks them itself, with no connection: a time-based code from a
 * per-device secret set up while online, or one of the one-time codes
 * printed in advance. Every code is bound to one device and one business
 * date, so a code for the front-desk computer, or for another night, never
 * opens the bar computer. The HMAC is handed in (Node's crypto on the API and
 * in the desktop app), so the rule stays pure.
 */
export type Hmac = (secretHex: string, message: string) => Uint8Array;

/** A time-based code lasts 5 minutes; a manager reads it off a phone and types it in. */
export const OFFLINE_CODE_STEP_SECONDS = 300;
/** One step either side is still accepted: the bar computer's clock may drift while offline. */
export const OFFLINE_CODE_SKEW_STEPS = 1;
export const OFFLINE_CODE_DIGITS = 6;
/** Printed codes are longer, so the two kinds never collide, and each works once. */
export const PRINTED_CODE_DIGITS = 8;
export const PRINTED_CODES_PER_NIGHT = 10;
/** How far ahead a manager's phone keeps each computer's codes. */
export const OFFLINE_CODES_AHEAD_HOURS = 12;

export interface OfflineCodeScope {
  readonly deviceId: string;
  readonly timeZone: string;
  readonly dayCutover: string;
}

/** What a computer tells the server about the secret it holds, without sending the secret. */
export function offlineSecretFingerprint(hmac: Hmac, secret: string): string {
  return Array.from(hmac(secret, "fingerprint").slice(0, 16), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** RFC 4226 dynamic truncation of an HMAC to `digits` decimal digits. */
function truncate(mac: Uint8Array, digits: number): string {
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

function stepOf(at: Temporal.Instant): number {
  return Math.floor(at.epochMilliseconds / 1000 / OFFLINE_CODE_STEP_SECONDS);
}

function stepStart(step: number): Temporal.Instant {
  return Temporal.Instant.fromEpochMilliseconds(step * OFFLINE_CODE_STEP_SECONDS * 1000);
}

function dateAt(at: Temporal.Instant, scope: OfflineCodeScope): string {
  return businessDate(at, scope.timeZone, scope.dayCutover).businessDate.toString();
}

/** The time-based code for one step: bound to the device and the business date the step starts in. */
function timeCode(hmac: Hmac, secret: string, scope: OfflineCodeScope, step: number): string {
  const date = dateAt(stepStart(step), scope);
  return truncate(hmac(secret, `time|${scope.deviceId}|${date}|${step}`), OFFLINE_CODE_DIGITS);
}

/** The time-based code shown right now. */
export function offlineCodeAt(
  hmac: Hmac,
  secret: string,
  scope: OfflineCodeScope,
  at: Temporal.Instant,
): string {
  return timeCode(hmac, secret, scope, stepOf(at));
}

export interface UpcomingCode {
  readonly starts_at: string;
  readonly ends_at: string;
  readonly code: string;
}

/** The codes a manager's phone keeps: from the current step, `hours` ahead. */
export function upcomingOfflineCodes(
  hmac: Hmac,
  secret: string,
  scope: OfflineCodeScope,
  from: Temporal.Instant,
  hours = OFFLINE_CODES_AHEAD_HOURS,
): UpcomingCode[] {
  const first = stepOf(from);
  const count = Math.ceil((hours * 3600) / OFFLINE_CODE_STEP_SECONDS);
  const out: UpcomingCode[] = [];
  for (let s = first; s < first + count; s++)
    out.push({
      starts_at: stepStart(s).toString(),
      ends_at: stepStart(s + 1).toString(),
      code: timeCode(hmac, secret, scope, s),
    });
  return out;
}

/** The one-time codes printed for a device and a business date, in order. */
export function printedOfflineCodes(
  hmac: Hmac,
  secret: string,
  deviceId: string,
  date: string,
): string[] {
  return Array.from({ length: PRINTED_CODES_PER_NIGHT }, (_, i) =>
    truncate(hmac(secret, `printed|${deviceId}|${date}|${i}`), PRINTED_CODE_DIGITS),
  );
}

export type OfflineCodeCheck =
  | { readonly ok: true; readonly kind: "time" }
  | { readonly ok: true; readonly kind: "printed"; readonly date: string; readonly index: number }
  | { readonly ok: false; readonly reason: "malformed" | "wrong" | "used" };

/** Spaces and dashes are how a code is read out and printed; they don't count. */
export function normalizeOfflineCode(code: string): string {
  return code.replace(/[\s-]/g, "");
}

/**
 * Check a code typed on the device itself. A time-based code from the step
 * now, or one either side; a printed code for this device and tonight's
 * business date that hasn't been used.
 */
export function checkOfflineCode(
  hmac: Hmac,
  secret: string,
  scope: OfflineCodeScope,
  at: Temporal.Instant,
  typed: string,
  usedPrinted: readonly number[] = [],
): OfflineCodeCheck {
  const code = normalizeOfflineCode(typed);
  if (!/^\d+$/.test(code)) return { ok: false, reason: "malformed" };
  if (code.length === OFFLINE_CODE_DIGITS) {
    const now = stepOf(at);
    for (let s = now - OFFLINE_CODE_SKEW_STEPS; s <= now + OFFLINE_CODE_SKEW_STEPS; s++)
      if (equal(timeCode(hmac, secret, scope, s), code)) return { ok: true, kind: "time" };
    return { ok: false, reason: "wrong" };
  }
  if (code.length === PRINTED_CODE_DIGITS) {
    const date = dateAt(at, scope);
    const index = printedOfflineCodes(hmac, secret, scope.deviceId, date).findIndex((c) =>
      equal(c, code),
    );
    if (index < 0) return { ok: false, reason: "wrong" };
    if (usedPrinted.includes(index)) return { ok: false, reason: "used" };
    return { ok: true, kind: "printed", date, index };
  }
  return { ok: false, reason: "malformed" };
}

/** Compare without stopping at the first difference. */
function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Queue mode lasts until the connection returns, or 4 hours, whichever is first. */
export const QUEUE_MODE_HOURS = 4;

export function queueModeEndsAt(openedAt: Temporal.Instant): Temporal.Instant {
  return openedAt.add({ hours: QUEUE_MODE_HOURS });
}
