import {
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectRetentionCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Worker, withVenue } from "@west4/db";
import {
  appPool,
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "@west4/db/test-helpers";
import { businessDate, wallClock } from "@west4/rules";
import { FrozenClock, Temporal } from "@west4/shared";
import { makeS3 } from "../s3.js";
import {
  AUDIT_EXPORT_KIND,
  auditExportSchedule,
  auditHeadKey,
  makeAuditExportHandler,
  type AuditHead,
} from "./audit-export.js";

let db: TestDatabase;
let pool: pg.Pool;
let v: TwoVenues;
const s3 = makeS3();
// Audit rows carry the database's real time, so the export runs at 6:05 AM New York on the
// business date after the real one: the real business date has just ended at 6:00.
const NY = "America/New_York";
const ended = businessDate(Temporal.Now.instant(), NY, "06:00").businessDate;
const clock = new FrozenClock(wallClock(ended.add({ days: 1 }), "06:05", NY, "06:00"));

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  pool = appPool(db.url);
});

afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe("the daily audit export", () => {
  it("after the cutover, the business date's last hash is in the write-once bucket, and overwriting or deleting it fails", async () => {
    // Some audited activity on the real business date.
    await withVenue(pool, { venueId: v.venueA, userId: v.ownerA, requestId: "r1" }, (c) =>
      c.query("update memberships set locale = 'es' where user_id = $1", [v.bartenderA]),
    );
    const expectedHead = await withVenue(
      pool,
      { venueId: v.venueA },
      async (c) =>
        (
          await c.query<{ id: string; hash: string }>(
            "select id, hash from audit_head_before($1, $2)",
            [v.venueA, new Date("2099-01-01")],
          )
        ).rows[0],
    );

    // The scheduler would queue this at 6:05; here the job is queued by hand and run by a bulk worker.
    await withVenue(pool, { venueId: v.venueA }, (c) =>
      c.query("insert into jobs (venue_id, kind, pool, run_at) values ($1, $2, 'bulk', $3)", [
        v.venueA,
        AUDIT_EXPORT_KIND,
        new Date(clock.now().epochMilliseconds),
      ]),
    );
    const worker = new Worker(pool, {
      pool: "bulk",
      clock,
      handlers: { [AUDIT_EXPORT_KIND]: makeAuditExportHandler(s3.client, s3.bucketAudit) },
    });
    expect(await worker.tick()).toBe(1);
    const status = await withVenue(
      pool,
      { venueId: v.venueA },
      async (c) =>
        (
          await c.query<{ status: string; last_error: string | null }>(
            "select status, last_error from jobs where kind = $1",
            [AUDIT_EXPORT_KIND],
          )
        ).rows[0],
    );
    expect(status).toEqual({ status: "done", last_error: null });

    // The date that ended has its head in the bucket with 6 years of compliance retention.
    const key = auditHeadKey(v.venueA, ended);
    const object = await s3.client.send(new GetObjectCommand({ Bucket: s3.bucketAudit, Key: key }));
    const body = JSON.parse((await object.Body?.transformToString()) ?? "{}") as AuditHead;
    expect(body.business_date).toBe(ended.toString());
    expect(body.hash).toBe(expectedHead?.hash);
    expect(body.audit_log_id).toBe(expectedHead?.id);
    const retention = await s3.client.send(
      new GetObjectRetentionCommand({ Bucket: s3.bucketAudit, Key: key }),
    );
    expect(retention.Retention?.Mode).toBe("COMPLIANCE");
    expect(retention.Retention?.RetainUntilDate?.getFullYear()).toBe(ended.year + 6);

    // Overwriting fails: the key exists.
    await expect(
      s3.client.send(
        new PutObjectCommand({ Bucket: s3.bucketAudit, Key: key, Body: "{}", IfNoneMatch: "*" }),
      ),
    ).rejects.toMatchObject({ name: "PreconditionFailed" });
    // Deleting the locked version fails.
    const versions = await s3.client.send(
      new ListObjectVersionsCommand({ Bucket: s3.bucketAudit, Prefix: key }),
    );
    const versionId = versions.Versions?.[0]?.VersionId;
    expect(versionId).toBeTruthy();
    await expect(
      s3.client.send(
        new DeleteObjectCommand({ Bucket: s3.bucketAudit, Key: key, VersionId: versionId }),
      ),
    ).rejects.toMatchObject({ name: "AccessDenied" });

    // Running the export again for the same date is refused by the store, so the job fails loudly rather than silently replacing.
    await withVenue(pool, { venueId: v.venueA }, (c) =>
      c.query(
        "insert into jobs (venue_id, kind, pool, run_at, max_attempts) values ($1, $2, 'bulk', $3, 1)",
        [v.venueA, AUDIT_EXPORT_KIND, new Date(clock.now().epochMilliseconds)],
      ),
    );
    expect(await worker.tick()).toBe(1);
    const second = await withVenue(
      pool,
      { venueId: v.venueA },
      async (c) =>
        (
          await c.query<{ status: string; last_error: string | null }>(
            "select status, last_error from jobs where kind = $1 order by created_at desc limit 1",
            [AUDIT_EXPORT_KIND],
          )
        ).rows[0],
    );
    expect(second?.status).toBe("dead");
    expect(second?.last_error).toMatch(/PreconditionFailed|pre-conditions/);
  });

  it("is scheduled daily at 06:05 in the bulk pool", () => {
    expect(auditExportSchedule).toMatchObject({
      kind: AUDIT_EXPORT_KIND,
      at: "06:05",
      pool: "bulk",
    });
  });
});
