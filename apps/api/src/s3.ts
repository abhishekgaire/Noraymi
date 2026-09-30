import { S3Client } from "@aws-sdk/client-s3";

export interface S3Settings {
  readonly client: S3Client;
  readonly bucketFiles: string;
  readonly bucketAudit: string;
}

/**
 * The object store: RustFS locally (S3_ENDPOINT set, path-style), S3 on AWS
 * (no endpoint; credentials come from the task role).
 */
export function makeS3(env: Record<string, string | undefined> = process.env): S3Settings {
  const endpoint = env["S3_ENDPOINT"];
  const accessKeyId = env["S3_ACCESS_KEY_ID"];
  const secretAccessKey = env["S3_SECRET_ACCESS_KEY"];
  const client = new S3Client({
    region: env["S3_REGION"] ?? env["AWS_REGION"] ?? "us-east-1",
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  });
  return {
    client,
    bucketFiles: env["S3_BUCKET_FILES"] ?? "west4-files",
    bucketAudit: env["S3_BUCKET_AUDIT"] ?? "west4-audit",
  };
}
