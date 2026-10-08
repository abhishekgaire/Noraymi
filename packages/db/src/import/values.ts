import { isIP } from "node:net";
import { Temporal } from "@west4/shared";

/**
 * Value readers for the old system's export files. Each returns the value or
 * a short reason; none uses a float for money.
 */
export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const bad = <T>(reason: string): Parsed<T> => ({ ok: false, reason });

/**
 * Money as integer cents, from "$1,234.50", "1234.5", "90" or "(12.00)".
 * In "cents" units the text must be a whole number. Never a float: the
 * dollars and cents are read as digits.
 */
export function parseCents(raw: string, unit: "dollars" | "cents" = "dollars"): Parsed<number> {
  let s = raw.trim().replace(/^\$|,/g, "").replace(/,/g, "");
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).replace(/^\$/, "");
  }
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1).replace(/^\$/, "");
  }
  if (unit === "cents") {
    if (!/^\d{1,12}$/.test(s)) return bad(`"${raw}" is not a whole number of cents`);
    const v = Number(s);
    return ok(negative ? -v : v);
  }
  const m = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return bad(`"${raw}" is not an amount in dollars and cents`);
  const v = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return ok(negative ? -v : v);
}

/**
 * An instant from the export: ISO with an offset ("2026-09-25T19:00:00-04:00"),
 * or a local wall-clock time ("2026-09-25 19:00", "2026-09-25T19:00") read in
 * the venue's zone. A local time that happens twice or never (the daylight-
 * saving nights) is refused, never guessed.
 */
export function parseInstant(raw: string, timeZone: string): Parsed<Temporal.Instant> {
  const s = raw.trim().replace(" ", "T");
  if (s === "") return bad("is empty");
  try {
    if (/(Z|[+-]\d{2}:?\d{2})$/.test(s)) return ok(Temporal.Instant.from(s));
    const local = Temporal.PlainDateTime.from(s);
    return ok(local.toZonedDateTime(timeZone, { disambiguation: "reject" }).toInstant());
  } catch {
    return bad(`"${raw}" is not a date and time (or it happens twice or never in ${timeZone})`);
  }
}

export function parseDate(raw: string): Parsed<string> {
  try {
    return ok(Temporal.PlainDate.from(raw.trim()).toString());
  } catch {
    return bad(`"${raw}" is not a date (YYYY-MM-DD)`);
  }
}

export function parseWholeNumber(raw: string, min: number, max: number): Parsed<number> {
  const s = raw.trim();
  if (!/^\d{1,6}$/.test(s)) return bad(`"${raw}" is not a whole number`);
  const v = Number(s);
  if (v < min || v > max) return bad(`${v} is outside ${min} to ${max}`);
  return ok(v);
}

const YES = new Set(["y", "yes", "true", "1", "x"]);
const NO = new Set(["n", "no", "false", "0", ""]);

export function parseYesNo(raw: string): Parsed<boolean> {
  const s = raw.trim().toLowerCase();
  if (YES.has(s)) return ok(true);
  if (NO.has(s)) return ok(false);
  return bad(`"${raw}" is not yes or no`);
}

/** A US or international phone number in E.164; a ten-digit number is a US one. */
export function parsePhone(raw: string): Parsed<string> {
  const s = raw.trim();
  const digits = s.replace(/[\s().-]/g, "");
  if (/^\+[1-9]\d{6,14}$/.test(digits)) return ok(digits);
  if (/^\d{10}$/.test(digits)) return ok(`+1${digits}`);
  if (/^1\d{10}$/.test(digits)) return ok(`+${digits}`);
  return bad(`"${raw}" is not a phone number`);
}

export function parseIp(raw: string): Parsed<string> {
  const s = raw.trim();
  return isIP(s) ? ok(s) : bad(`"${raw}" is not an IP address`);
}

export function parseEmail(raw: string): Parsed<string> {
  const s = raw.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254) return ok(s);
  return bad(`"${raw}" is not an email address`);
}

/**
 * Column names that would carry a PIN, a password or card data. A file with
 * one is refused whole, whether or not the mapping reads that column.
 */
const PIN_HEADERS = [
  /(^|[^a-z])pins?([^a-z]|$)/i,
  /[a-z](PIN|Pin)s?([^a-z]|$)/,
  /pass[\s_-]?code|password|(^|[^a-z])pwd([^a-z]|$)/i,
];
const CARD_HEADER =
  /\b(credit[\s_-]?)?card[\s_-]?(number|num|no|#)|\bcc[\s_-]?(number|num|no|#)?\b|\bpan\b|\bcvv2?\b|\bcvc2?\b|security[\s_-]?code|\bexp(iry|iration)?[\s_-]?(date|month|year)\b|\btrack[\s_-]?[12]\b|\bmagstripe\b/i;

export function sensitiveHeader(header: string): "pin" | "card" | undefined {
  const h = header.trim();
  if (PIN_HEADERS.some((r) => r.test(h))) return "pin";
  if (CARD_HEADER.test(h)) return "card";
  return undefined;
}

/**
 * True when the text holds a run of 13 to 19 digits (spaces and dashes
 * allowed between them) that passes the Luhn check: a card number, wherever
 * it sits in the cell. A long reference number can trip it too; the file is
 * then refused and the column dropped from the export, the cautious way round.
 */
export function containsCardNumber(raw: string): boolean {
  for (const m of raw.matchAll(/\d(?:[ -]?\d){12,18}/g)) {
    const digits = m[0].replace(/[ -]/g, "");
    let sum = 0;
    for (let i = 0; i < digits.length; i += 1) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}
