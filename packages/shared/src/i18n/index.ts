import { en } from "./en.js";
import { es } from "./es.js";

export const locales = ["en", "es"] as const;
export type Locale = (typeof locales)[number];
export type MessageKey = keyof typeof en;

export const catalogs: { readonly [L in Locale]: { readonly [K in MessageKey]: string } } = {
  en,
  es,
};

/** Look up one string. A missing key is a type error, so there is no fallback path. */
export function t(locale: Locale, key: MessageKey): string {
  return catalogs[locale][key];
}
