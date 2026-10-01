import type pg from "pg";
import type { JobHandler, Schedule, Sweep } from "@west4/db";
import type { S3Settings } from "../s3.js";
import type { Mailer } from "../email/mailer.js";
import type { EmailSettings } from "../email/settings.js";
import { EMAIL_SEND_KIND, makeSendEmailHandler } from "./send-email.js";
import { deviceWatchSweep } from "./device-watch.js";
import { holdSweep } from "./hold-sweep.js";
import { PUSH_SEND_KIND, makePushSendHandler } from "../push/send-push.js";
import type { PushSender } from "../push/sender.js";
import { TEXT_SEND_KIND, makeSendTextHandler } from "./send-text.js";
import type { TextSender } from "../texts/sender.js";
import { AUDIT_EXPORT_KIND, auditExportSchedule, makeAuditExportHandler } from "./audit-export.js";
import {
  EVENTS_CLEANUP_KIND,
  eventsCleanupHandler,
  eventsCleanupSchedule,
} from "./events-cleanup.js";
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
export interface HandlerDeps {
  readonly s3: S3Settings;
  readonly mailer: Mailer;
  readonly email: EmailSettings;
  readonly push: PushSender;
  readonly texts: TextSender;
}

export function makeHandlers({
  s3,
  mailer,
  email,
  push,
  texts,
}: HandlerDeps): Record<"critical" | "normal" | "bulk", Record<string, JobHandler>> {
  return {
    critical: {},
    normal: {
      [EMAIL_SEND_KIND]: makeSendEmailHandler(mailer, email),
      [PUSH_SEND_KIND]: makePushSendHandler(push),
      [TEXT_SEND_KIND]: makeSendTextHandler(texts),
    },
    bulk: {
      [AUDIT_EXPORT_KIND]: makeAuditExportHandler(s3.client, s3.bucketAudit),
      [IDEMPOTENCY_CLEANUP_KIND]: idempotencyCleanupHandler,
      [EVENTS_CLEANUP_KIND]: eventsCleanupHandler,
    },
  };
}

export const schedules: Schedule[] = [
  auditExportSchedule,
  idempotencyCleanupSchedule,
  eventsCleanupSchedule,
];

/** What the scheduler's leader checks between ticks (M1-16: quiet devices). */
export function makeSweeps(pool: pg.Pool, log?: (line: string) => void): Sweep[] {
  return [deviceWatchSweep(pool, log), holdSweep(pool)];
}
