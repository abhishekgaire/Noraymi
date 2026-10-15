import type { Temporal } from "@west4/shared";

/**
 * The next half hour on the venue's clock, as "HH:MM" (U-13, D133): New booking's time starts
 * here. 10:41 PM gives 23:00, 10:00 PM gives 22:30, 11:45 PM gives 00:00.
 */
export function nextHalfHour(now: Temporal.Instant, timeZone: string): string {
  const z = now.toZonedDateTimeISO(timeZone);
  const next =
    z.minute < 30
      ? z.with({ minute: 30, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 })
      : z
          .with({ minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 })
          .add({ hours: 1 });
  return `${String(next.hour).padStart(2, "0")}:${String(next.minute).padStart(2, "0")}`;
}
