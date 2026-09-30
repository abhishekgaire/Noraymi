import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { JobContext, JobHandler, Schedule } from "@west4/db";
import { businessDate, wallClock } from "@west4/rules";
import type { Temporal } from "@west4/shared";

/**
 * The daily write-once export (M1-07): after the 6:00 AM cutover, each
 * venue's last audit hash of the business date that just ended goes to the
 * audit bucket under Object Lock in compliance mode, kept 6 years (spec 12 ·
 * How long we keep things). The key is one per venue and date, and the put
 * is conditional on the key not existing, so an export can never be
 * overwritten; the locked version can't be deleted either.
 */
export const AUDIT_EXPORT_KIND = "audit.export_heads";
export const AUDIT_RETENTION_YEARS = 6;

export const auditExportSchedule: Schedule = {
  kind: AUDIT_EXPORT_KIND,
  at: "06:05",
  pool: "bulk",
  maxAttempts: 10,
};

export interface AuditHead {
  readonly venue_id: string;
  readonly business_date: string;
  readonly audit_log_id: string;
  readonly hash: string;
  readonly at: string;
  readonly exported_at: string;
}

export function auditHeadKey(venueId: string, date: Temporal.PlainDate): string {
  return `audit-heads/${venueId}/${date.toString()}.json`;
}

export function makeAuditExportHandler(s3: S3Client, bucket: string): JobHandler {
  return async ({ job, clock, step }: JobContext) => {
    // The job runs early on business date D; the date that ended is D - 1,
    // and it ended at D's cutover instant in the venue's zone.
    const venue = await step(async (c) => {
      const r = await c.query<{ time_zone: string; day_cutover: string }>(
        "select time_zone, to_char(day_cutover, 'HH24:MI') as day_cutover from venues where id = $1",
        [job.venue_id],
      );
      if (!r.rows[0]) throw new Error(`venue ${job.venue_id} not visible`);
      return r.rows[0];
    });
    const now = clock.now();
    const today = businessDate(now, venue.time_zone, venue.day_cutover).businessDate;
    const ended = today.subtract({ days: 1 });
    const cutover = wallClock(today, venue.day_cutover, venue.time_zone, venue.day_cutover);

    const head = await step(async (c) => {
      const r = await c.query<{ id: string; hash: string; at: Date }>(
        "select id, hash, at from audit_head_before($1, $2)",
        [job.venue_id, new Date(cutover.epochMilliseconds)],
      );
      return r.rows[0];
    });
    if (!head) return; // nothing audited yet for this venue

    const body: AuditHead = {
      venue_id: job.venue_id,
      business_date: ended.toString(),
      audit_log_id: head.id,
      hash: head.hash,
      at: head.at.toISOString(),
      exported_at: now.toString(),
    };
    // No transaction is open here: the outside call happens between steps.
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: auditHeadKey(job.venue_id, ended),
        Body: JSON.stringify(body),
        ContentType: "application/json",
        ObjectLockMode: "COMPLIANCE",
        ObjectLockRetainUntilDate: new Date(
          now.add({ hours: 24 * 365 * AUDIT_RETENTION_YEARS }).epochMilliseconds,
        ),
        IfNoneMatch: "*",
      }),
    );
  };
}
