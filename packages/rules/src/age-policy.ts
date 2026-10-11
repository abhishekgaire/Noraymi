import { Temporal } from "@west4/shared";
import { businessDate, parseCutover, wallClock } from "./time.js";

/**
 * The venue's age policy (D108; spec 03 · safety.allAgesUntil). `allAgesUntil` is "HH:MM" on the
 * wall clock, read in the business date: all ages until then, 21 and over after. Empty (null) is
 * 21 and over all night (West 4). A time equal to the cutover is the night's end, so it never
 * switches. These are words for the website, the booking pages and the board; the alcohol rules
 * (an ID check per guest, on the server) don't change with them.
 */
export function ageSwitchAt(
  date: Temporal.PlainDate | string,
  allAgesUntil: string | null | undefined,
  timeZone: string,
  cutover: string,
): Temporal.Instant | null {
  if (!allAgesUntil) return null;
  if (Temporal.PlainTime.compare(parseCutover(allAgesUntil), parseCutover(cutover)) === 0)
    return null;
  return wallClock(date, allAgesUntil, timeZone, cutover);
}

/** Whether 21 and over applies at an instant: always without a switch, else from the switch on. */
export function twentyOneAt(
  at: Temporal.Instant | string,
  allAgesUntil: string | null | undefined,
  timeZone: string,
  cutover: string,
): boolean {
  const now = typeof at === "string" ? Temporal.Instant.from(at) : at;
  const date = businessDate(now, timeZone, cutover).businessDate;
  const at21 = ageSwitchAt(date, allAgesUntil, timeZone, cutover);
  return at21 === null || Temporal.Instant.compare(now, at21) >= 0;
}

/**
 * The switch a booking runs past ("21+ after 8:00 PM · bring ID"): the instant 21 and over starts
 * on the booking's night, when the booking ends after it. Null when there's no switch (21 and over
 * all night, said once on the site) or the booking is over before it.
 */
export function bookingAgeSwitch(
  start: Temporal.Instant | string,
  end: Temporal.Instant | string,
  allAgesUntil: string | null | undefined,
  timeZone: string,
  cutover: string,
): Temporal.Instant | null {
  const s = typeof start === "string" ? Temporal.Instant.from(start) : start;
  const e = typeof end === "string" ? Temporal.Instant.from(end) : end;
  const date = businessDate(s, timeZone, cutover).businessDate;
  const at21 = ageSwitchAt(date, allAgesUntil, timeZone, cutover);
  return at21 && Temporal.Instant.compare(e, at21) > 0 ? at21 : null;
}
