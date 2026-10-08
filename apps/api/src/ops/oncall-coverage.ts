import { z } from "zod";
import type { Queryable } from "@west4/db";
import {
  coverageGaps,
  shiftAt,
  wallClock,
  type CoverageGap,
  type NightWindow,
  type RotaShift,
} from "@west4/rules";
import { Temporal } from "@west4/shared";
import { nightHours, venueClock } from "../rooms/assignment.js";
import { setRota, type RotaEntry } from "./paging.js";

/**
 * The gate's on-call rota (M9-16; spec 13 · On call): `docs/gate/oncall-rota.json` names, shift by
 * shift, who answers first and who second for every opening hour of the 4 weeks. Times are the
 * venue's wall clock ("2026-10-19T16:00"); people are our Console staff by email, as `oncall:set`
 * takes them. Nobody is filled in for you: the file ships empty, and the check fails until the
 * founder names the first live night and the people.
 */
const local = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "a wall-clock time YYYY-MM-DDTHH:MM");
export const rotaFileSchema = z
  .object({
    venue: z.string().min(1),
    /** The first live night's business date; null until the founder sets it. */
    starts_on: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    weeks: z.number().int().min(1).max(12),
    shifts: z.array(
      z
        .object({
          from: local,
          to: local,
          first: z.string().email(),
          second: z.string().email(),
          first_phone: z
            .string()
            .regex(/^\+\d{8,15}$/)
            .nullable()
            .optional(),
          second_phone: z
            .string()
            .regex(/^\+\d{8,15}$/)
            .nullable()
            .optional(),
        })
        .strict(),
    ),
  })
  .passthrough();
export type RotaFile = z.infer<typeof rotaFileSchema>;
type FileShift = RotaFile["shifts"][number];

const instant = (wall: string, timeZone: string) =>
  Temporal.PlainDateTime.from(wall)
    .toZonedDateTime(timeZone, { disambiguation: "earlier" })
    .toInstant();

/** Each night of the gate, from its opening to the next business date's start (the cutover). */
export async function gateWindows(
  c: Queryable,
  venueId: string,
  startsOn: string,
  weeks: number,
): Promise<NightWindow[]> {
  const venue = await venueClock(c, venueId);
  const out: NightWindow[] = [];
  for (let i = 0; i < weeks * 7; i++) {
    const date = Temporal.PlainDate.from(startsOn).add({ days: i });
    const h = await nightHours(c, venueId, venue, date);
    if (!h) continue; // closed that night
    const next = date.add({ days: 1 });
    out.push({
      businessDate: date.toString(),
      from: h.opens,
      to: wallClock(next, venue.dayCutover, venue.timeZone, venue.dayCutover),
    });
  }
  return out;
}

export function shiftsOf(file: RotaFile, timeZone: string): (RotaShift & { source: FileShift })[] {
  return file.shifts.map((s) => ({
    from: instant(s.from, timeZone),
    to: instant(s.to, timeZone),
    first: s.first,
    second: s.second,
    source: s,
  }));
}

export interface CoverageReport {
  readonly ok: boolean;
  readonly nights: number;
  readonly gaps: readonly CoverageGap[];
  /** Responders the rota names who aren't active Console staff. */
  readonly unknown: readonly string[];
  readonly problems: readonly string[];
}

export async function checkCoverage(
  c: Queryable,
  venueId: string,
  file: RotaFile,
): Promise<CoverageReport> {
  const problems: string[] = [];
  if (!file.starts_on) problems.push("starts_on is empty: set it to the first live night");
  if (file.shifts.length === 0)
    problems.push("no shifts: name a first and a second responder for every opening hour");
  const venue = await venueClock(c, venueId);
  const windows = file.starts_on ? await gateWindows(c, venueId, file.starts_on, file.weeks) : [];
  const gaps = coverageGaps(windows, shiftsOf(file, venue.timeZone));
  const people = [
    ...new Set(file.shifts.flatMap((s) => [s.first.toLowerCase(), s.second.toLowerCase()])),
  ];
  const known = new Set(
    (
      await c.query<{ email: string }>(
        "select lower(email) as email from console_staff where active and lower(email) = any($1::text[])",
        [people],
      )
    ).rows.map((r) => r.email),
  );
  const unknown = people.filter((p) => !known.has(p));
  return {
    ok: problems.length === 0 && gaps.length === 0 && unknown.length === 0,
    nights: windows.length,
    gaps,
    unknown,
    problems,
  };
}

/** At a handover: the shift on now goes into the pager's two slots (`oncall:set`'s table). */
export async function applyShift(
  c: Queryable,
  file: RotaFile,
  timeZone: string,
  now: Temporal.Instant,
  by: string,
): Promise<RotaEntry[] | null> {
  const on = shiftAt(shiftsOf(file, timeZone), now) as (RotaShift & { source: FileShift }) | null;
  if (!on) return null;
  return [
    await setRota(c, "first", on.first, on.source.first_phone ?? null, by),
    await setRota(c, "second", on.second, on.source.second_phone ?? null, by),
  ];
}
