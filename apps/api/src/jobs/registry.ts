import type { JobHandler, Schedule } from "@west4/db";

/**
 * Every job kind the workers know, by pool, and every daily schedule.
 * Later tickets add to these: captures and readers are critical, texts are
 * normal, exports and retention are bulk.
 */
export const handlers: Record<"critical" | "normal" | "bulk", Record<string, JobHandler>> = {
  critical: {},
  normal: {},
  bulk: {},
};

export const schedules: Schedule[] = [];
