import {
  PUBLIC_FORM_DEFAULTS,
  type FormLimits,
  type PublicForm,
  type PublicFormsSettings,
} from "@west4/shared";

/**
 * The public forms' daily limits (M2-27, D109; Security 8): one business date's accepted uses of a
 * form, counted per phone number, IP address and device. The phone number is checked first, then
 * the device, then the IP address, so a guest hears about the limit that's theirs before the one a
 * whole Wi-Fi network shares. A use the request can't name (no device yet, no phone on a booking's
 * first step) is never over its limit.
 */
export type LimitedBy = "phone" | "device" | "ip";

export interface FormUseCounts {
  readonly phone: number | null;
  readonly ip: number | null;
  readonly device: number | null;
}

/** The limits in force for one form: the venue's own, or the default for a form it hasn't set. */
export function formLimits(
  settings: PublicFormsSettings | null | undefined,
  form: PublicForm,
): FormLimits {
  return settings?.[form] ?? PUBLIC_FORM_DEFAULTS[form];
}

/** Which limit one more use would pass, or null when it's allowed. A count is the uses already made today. */
export function dailyLimitHit(counts: FormUseCounts, limits: FormLimits): LimitedBy | null {
  if (counts.phone !== null && counts.phone >= limits.perPhone) return "phone";
  if (counts.device !== null && counts.device >= limits.perDevice) return "device";
  if (counts.ip !== null && counts.ip >= limits.perIp) return "ip";
  return null;
}
