import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import {
  formatDate,
  formatMoney,
  formatTime,
  t,
  tn,
  type Cents,
  type Locale,
  type MessageKey,
  type MessageParams,
  type PluralKey,
  type Role,
} from "@west4/shared";
import type { Temporal } from "@west4/shared";

const LocaleContext = createContext<Locale>("en");

/** The language every string under it is rendered in; the <html lang> follows it. */
export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale(): Locale {
  return useContext(LocaleContext);
}

export const roleKey: { readonly [R in Role]: MessageKey } = {
  owner: "role.owner",
  manager: "role.manager",
  bartender: "role.bartender",
  front_desk: "role.front_desk",
  staff: "role.staff",
};

/** The catalog, bound to the current language: t for strings, tn for counts, money, time and date. */
export function useT() {
  const locale = useLocale();
  return useMemo(
    () => ({
      locale,
      t: (key: MessageKey, params?: MessageParams) => t(locale, key, params),
      tn: (base: PluralKey, count: number, params?: MessageParams) =>
        tn(locale, base, count, params),
      money: (cents: Cents) => formatMoney(locale, cents),
      time: (at: Temporal.Instant | string, timeZone: string) => formatTime(locale, at, timeZone),
      date: (date: Temporal.PlainDate | string) => formatDate(locale, date),
    }),
    [locale],
  );
}
