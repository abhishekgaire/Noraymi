import { DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type pg from "pg";
import { emitEvent, withVenue, type Queryable } from "@west4/db";
import { FILE_RULES, type FileKind, type Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import type { S3Settings } from "../s3.js";

/**
 * Files (M2-13). The client never sends file bytes through the API: it gets a
 * presigned POST whose conditions fix the key, the type and the size range,
 * and storage refuses anything else. Downloads are short-lived signed links.
 */
export const UPLOAD_SECONDS = 300;
export const DOWNLOAD_SECONDS = 300;
export const UNATTACHED_HOURS = 24;

export async function newUpload(
  c: Queryable,
  s3: S3Settings,
  input: {
    venueId: string;
    kind: FileKind;
    contentType: string;
    bytes: number;
    uploadedBy: string | null;
    now: Temporal.Instant;
  },
) {
  const rule = FILE_RULES[input.kind];
  const what = input.kind.replace(/_/g, " ");
  if (!rule.types.includes(input.contentType))
    throw new ApiError("invalid_request", `a ${what} is ${rule.types.join(", ")}`, {
      details: { reason: "type" },
    });
  if (input.bytes > rule.maxBytes)
    throw new ApiError(
      "invalid_request",
      `a ${what} is at most ${rule.maxBytes / (1024 * 1024)} MB`,
      { details: { reason: "size" } },
    );
  const row = (
    await c.query<{ id: string; storage_key: string }>(
      `insert into files (venue_id, kind, storage_key, content_type, bytes, uploaded_by, uploaded_at)
         values ($1::uuid, $2, $1::text || '/' || $2::text || '/' || gen_random_uuid(), $3, $4, $5, $6) returning id, storage_key`,
      [
        input.venueId,
        input.kind,
        input.contentType,
        input.bytes,
        input.uploadedBy,
        input.now.toString(),
      ],
    )
  ).rows[0]!;
  // Presigning is local signing, not a network call, so it's fine inside the transaction.
  const post = await createPresignedPost(s3.client, {
    Bucket: s3.bucketFiles,
    Key: row.storage_key,
    Fields: { "Content-Type": input.contentType },
    Conditions: [
      ["eq", "$Content-Type", input.contentType],
      ["content-length-range", 1, rule.maxBytes],
    ],
    Expires: UPLOAD_SECONDS,
  });
  return {
    file_id: row.id,
    upload: { url: post.url, fields: post.fields },
    max_bytes: rule.maxBytes,
  };
}

export async function downloadLink(
  c: Queryable,
  s3: S3Settings,
  venueId: string,
  fileId: string,
  seconds = DOWNLOAD_SECONDS,
) {
  const file = (
    await c.query<{ storage_key: string; removed_at: string | null }>(
      "select storage_key, removed_at from files where venue_id = $1 and id = $2",
      [venueId, fileId],
    )
  ).rows[0];
  if (!file || file.removed_at) throw new ApiError("not_found", "no such file");
  const url = await getSignedUrl(
    s3.client,
    new GetObjectCommand({ Bucket: s3.bucketFiles, Key: file.storage_key }),
    {
      expiresIn: seconds,
    },
  );
  return { url, expires_in: seconds };
}

/** A row that needs a file attaches it; only then does it count. */
export async function attachFile(
  c: Queryable,
  venueId: string,
  fileId: string,
  at: Temporal.Instant,
): Promise<boolean> {
  const r = await c.query(
    "update files set attached_at = $3 where venue_id = $1 and id = $2 and removed_at is null",
    [venueId, fileId, at.toString()],
  );
  return r.rowCount === 1;
}

/** Uploads nothing attached within 24 hours go: the object from storage, the row marked removed. */
export async function sweepUnattachedFiles(pool: pg.Pool, s3: S3Settings, now: Temporal.Instant) {
  const venues = await pool.query<{ id: string }>("select id from venues_for_scheduler()");
  const removed: string[] = [];
  const cutoff = now.subtract({ hours: UNATTACHED_HOURS }).toString();
  for (const v of venues.rows) {
    const stale = await withVenue(
      pool,
      { venueId: v.id, requestId: "sweep:files" },
      async (c) =>
        (
          await c.query<{ id: string; storage_key: string }>(
            "select id, storage_key from files where venue_id = $1 and attached_at is null and removed_at is null and uploaded_at <= $2",
            [v.id, cutoff],
          )
        ).rows,
    );
    for (const f of stale) {
      // The storage call happens between transactions, never inside one.
      await s3.client.send(new DeleteObjectCommand({ Bucket: s3.bucketFiles, Key: f.storage_key }));
      await withVenue(pool, { venueId: v.id, requestId: "sweep:files" }, async (c) => {
        await c.query("update files set removed_at = $3 where venue_id = $1 and id = $2", [
          v.id,
          f.id,
          now.toString(),
        ]);
        await emitEvent(c, {
          venueId: v.id,
          type: "file.removed",
          entityId: f.id,
          entityVersion: 0,
        });
      });
      removed.push(f.id);
    }
  }
  return removed;
}
