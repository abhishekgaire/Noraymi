import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The Friday-night load test (M8-21) alone: `pnpm test:load`. It is timing-bound
// (the bar alarm within 3 s), so it never shares the machine with the
// integration suite. Needs Postgres: `docker compose up -d`.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    name: "api:load",
    include: ["src/load/**/*.int.test.ts"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 120_000,
    // The same local services as the integration suite (docker-compose.yml's defaults).
    env: {
      S3_ENDPOINT: process.env["S3_ENDPOINT"] ?? "http://localhost:9000",
      S3_REGION: process.env["S3_REGION"] ?? "us-east-1",
      S3_ACCESS_KEY_ID: process.env["S3_ACCESS_KEY_ID"] ?? "west4",
      S3_SECRET_ACCESS_KEY: process.env["S3_SECRET_ACCESS_KEY"] ?? "west4secret",
      S3_BUCKET_FILES: process.env["S3_BUCKET_FILES"] ?? "west4-files",
      S3_BUCKET_AUDIT: process.env["S3_BUCKET_AUDIT"] ?? "west4-audit",
      SMTP_URL: process.env["SMTP_URL"] ?? "smtp://localhost:1025",
      MAILPIT_URL: process.env["MAILPIT_URL"] ?? "http://localhost:8025",
    },
  },
});
