import { defineConfig } from "vitest/config";

// Needs Postgres and the local S3 store: `docker compose up -d`. The S3
// settings default to docker-compose.yml's; CI sets the same ones explicitly.
export default defineConfig({
  test: {
    name: "api:integration",
    include: ["src/**/*.int.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      S3_ENDPOINT: process.env["S3_ENDPOINT"] ?? "http://localhost:9000",
      S3_REGION: process.env["S3_REGION"] ?? "us-east-1",
      S3_ACCESS_KEY_ID: process.env["S3_ACCESS_KEY_ID"] ?? "west4",
      S3_SECRET_ACCESS_KEY: process.env["S3_SECRET_ACCESS_KEY"] ?? "west4secret",
      S3_BUCKET_FILES: process.env["S3_BUCKET_FILES"] ?? "west4-files",
      S3_BUCKET_AUDIT: process.env["S3_BUCKET_AUDIT"] ?? "west4-audit",
    },
  },
});
