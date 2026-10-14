import type { MessageKey, MessageParams } from "@west4/shared";

type T = (key: MessageKey, params?: MessageParams) => string;

/** A length as the walk-in dialog says it (D128): "2 h", "1½ h", or "75 min". */
export function lengthText(t: T, minutes: number): string {
  if (minutes % 60 === 30) return t("checkIn.hoursHalf", { hours: Math.floor(minutes / 60) });
  if (minutes % 60 === 0) return t("checkIn.hours", { hours: minutes / 60 });
  return t("session.minutes", { min: minutes });
}

/** A room's prepaid block (P-04): "Prepaid block · 2 h", or "Party pack · prepaid 2 h". */
export function prepaidText(
  t: T,
  prepaid: { readonly minutes: number; readonly package_name: string | null },
): string {
  const length = lengthText(t, prepaid.minutes);
  return prepaid.package_name
    ? t("session.prepaidPackage", { package: prepaid.package_name, length })
    : t("session.prepaid", { length });
}
