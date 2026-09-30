import type { JobContext, JobHandler, Schedule } from "@west4/db";

/** Events are kept 72 hours (spec 08 · Live events); this daily job clears older ones. */
export const EVENTS_CLEANUP_KIND = "events.clear_old";
export const EVENTS_RETENTION_HOURS = 72;

export const eventsCleanupSchedule: Schedule = {
  kind: EVENTS_CLEANUP_KIND,
  at: "06:40",
  pool: "bulk",
};

export const eventsCleanupHandler: JobHandler = async ({ clock, step }: JobContext) => {
  const before = clock.now().subtract({ hours: EVENTS_RETENTION_HOURS });
  await step((c) => c.query("select clear_venue_events($1)", [new Date(before.epochMilliseconds)]));
};
