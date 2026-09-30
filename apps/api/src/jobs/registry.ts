import type { JobHandler, Schedule } from "@west4/db";
import type { S3Settings } from "../s3.js";
import { AUDIT_EXPORT_KIND, auditExportSchedule, makeAuditExportHandler } from "./audit-export.js";
import {
  IDEMPOTENCY_CLEANUP_KIND,
  idempotencyCleanupHandler,
  idempotencyCleanupSchedule,
} from "./idempotency-cleanup.js";

/**
 * Every job kind the workers know, by pool, and every daily schedule.
 * Captures and readers are critical, texts are normal, exports and
 * retention are bulk. Later tickets add to these.
 */
export function makeHandlers(
  s3: S3Settings,
): Record<"critical" | "normal" | "bulk", Record<string, JobHandler>> {
  return {
    critical: {},
    normal: {},
    bulk: {
      [AUDIT_EXPORT_KIND]: makeAuditExportHandler(s3.client, s3.bucketAudit),
      [IDEMPOTENCY_CLEANUP_KIND]: idempotencyCleanupHandler,
    },
  };
}

export const schedules: Schedule[] = [auditExportSchedule, idempotencyCleanupSchedule];
