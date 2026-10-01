import { Temporal } from "../temporal.js";
import type { Cents } from "../money.js";
import { en } from "./en.js";
import { es } from "./es.js";

export const locales = ["en", "es"] as const;
export type Locale = (typeof locales)[number];
export type MessageKey = keyof typeof en;

/** The BCP 47 tag behind each staff language. Spanish is es-US: a US venue, US dollars, "10:41 p.m.". */
export const localeTags: { readonly [L in Locale]: string } = { en: "en-US", es: "es-US" };

/** Each language named in itself, as the sign-in screen shows them: "English · Español" (spec 02). */
export const localeNames: { readonly [L in Locale]: string } = { en: "English", es: "Español" };

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (locales as readonly string[]).includes(value);
}

export const catalogs: { readonly [L in Locale]: { readonly [K in MessageKey]: string } } = {
  en,
  es,
};

export type MessageParams = Readonly<Record<string, string | number>>;

/**
 * Look up one string. A missing key is a type error, so there is no fallback
 * path. `{name}` placeholders are filled from params; a number is written the
 * way the language writes numbers ("1,234" in English, "1234" in Spanish).
 */
export function t(locale: Locale, key: MessageKey, params?: MessageParams): string {
  const text = catalogs[locale][key];
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    if (value === undefined) return match;
    return typeof value === "number" ? formatNumber(locale, value) : value;
  });
}

/** The base of every plural pair in the catalog: "x.one" and "x.other" give the base "x". */
export type PluralKey = {
  [K in MessageKey]: K extends `${infer Base}.other` ? Base : never;
}[MessageKey];

/**
 * A counted string. The language's plural rules pick the form ("one" or
 * "other" in both English and Spanish), and {count} is filled in.
 */
export function tn(locale: Locale, base: PluralKey, count: number, params?: MessageParams): string {
  const category = new Intl.PluralRules(localeTags[locale]).select(count);
  const wanted = `${base}.${category}`;
  const key = (wanted in catalogs.en ? wanted : `${base}.other`) as MessageKey;
  return t(locale, key, { ...params, count });
}

export function formatNumber(locale: Locale, value: number): string {
  return new Intl.NumberFormat(localeTags[locale]).format(value);
}

/**
 * Cents as the language writes dollars. The amount stays an integer: the
 * formatter is handed the decimal string "618.60", never 618.6 as a float.
 */
export function formatMoney(locale: Locale, cents: Cents): string {
  if (!Number.isInteger(cents)) throw new TypeError(`cents must be an integer, got ${cents}`);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const decimal = `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  return new Intl.NumberFormat(localeTags[locale], { style: "currency", currency: "USD" }).format(
    decimal as unknown as number,
  );
}

/** "10:41 PM" or "10:41 p.m.", on the venue's clock, never the device's. */
export function formatTime(
  locale: Locale,
  at: Temporal.Instant | string,
  timeZone: string,
): string {
  const instant = typeof at === "string" ? Temporal.Instant.from(at) : at;
  return new Intl.DateTimeFormat(localeTags[locale], {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(new Date(instant.epochMilliseconds));
}

/** "Fri, Sep 25" or "vie, 25 sept": a calendar date, such as the business date. */
export function formatDate(locale: Locale, date: Temporal.PlainDate | string): string {
  const day = typeof date === "string" ? Temporal.PlainDate.from(date) : date;
  return new Intl.DateTimeFormat(localeTags[locale], {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(day.year, day.month - 1, day.day)));
}
