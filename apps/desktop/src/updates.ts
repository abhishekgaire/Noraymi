import { Temporal } from "@west4/shared";
import { businessDate, parseCutover } from "@west4/rules";

/**
 * Updates only between business days (spec 09, spec 13 · Releases): an
 * update that finished downloading during the night installs at the next
 * 6:00 AM on the venue's clock, or at the first start after it, never
 * mid-night. Pure, so it's tested on the simulated clock; main.ts wires it
 * to electron-updater.
 */
export interface VenueClock {
  readonly timeZone: string;
  /** "06:00" */
  readonly dayCutover: string;
}

/** The first cutover strictly after an instant: the start of the next business date. */
export function nextCutoverAfter(
  at: Temporal.Instant | string,
  clock: VenueClock,
): Temporal.Instant {
  const instant = typeof at === "string" ? Temporal.Instant.from(at) : at;
  const today = businessDate(instant, clock.timeZone, clock.dayCutover).businessDate;
  const cut = parseCutover(clock.dayCutover);
  return today
    .add({ days: 1 })
    .toZonedDateTime({ timeZone: clock.timeZone, plainTime: cut })
    .toInstant();
}

export class UpdateGate {
  private downloadedAt: Temporal.Instant | null = null;

  constructor(private clock: VenueClock | null) {}

  setClock(clock: VenueClock): void {
    this.clock = clock;
  }

  /** An update finished downloading: it waits for the cutover. */
  downloaded(at: Temporal.Instant | string): void {
    this.downloadedAt = typeof at === "string" ? Temporal.Instant.from(at) : at;
  }

  get pending(): boolean {
    return this.downloadedAt !== null;
  }

  /** When the pending update may install, or null when nothing is pending or the venue's clock isn't known yet. */
  dueAt(): Temporal.Instant | null {
    if (!this.downloadedAt || !this.clock) return null;
    return nextCutoverAfter(this.downloadedAt, this.clock);
  }

  /** True once the cutover after the download has passed: at 6:00 AM, or at the first start after it. */
  isDue(now: Temporal.Instant | string): boolean {
    const due = this.dueAt();
    if (!due) return false;
    const instant = typeof now === "string" ? Temporal.Instant.from(now) : now;
    return Temporal.Instant.compare(instant, due) >= 0;
  }
}
