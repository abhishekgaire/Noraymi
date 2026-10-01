import { defineConfig } from "@playwright/test";

const ci = !!process.env["CI"];

// One smoke test per app (M1-01). Each web app gets its dev server; the
// desktop test launches Electron itself and points it at the staff server.
export default defineConfig({
  testDir: "e2e",
  // Every run starts from a fresh load of the demo seed (M1-17); needs Postgres.
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  // One worker: the API and staff tests both re-enrol Andy's passkey against the one seed, so they can't overlap.
  workers: 1,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  reporter: ci ? [["github"], ["html", { open: "never" }]] : "list",
  timeout: 60_000,
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "api", testMatch: /api\.spec\.ts/, use: { baseURL: "http://127.0.0.1:3000" } },
    { name: "staff", testMatch: /staff\.spec\.ts/, use: { baseURL: "http://localhost:5173" } },
    { name: "console", testMatch: /console\.spec\.ts/, use: { baseURL: "http://localhost:5174" } },
    { name: "guest", testMatch: /guest\.spec\.ts/, use: { baseURL: "http://localhost:3001" } },
    { name: "desktop", testMatch: /desktop\.spec\.ts/ },
  ],
  webServer: [
    {
      // dev:test never reads .env, so the smoke tests can't pick up real credentials.
      command: "pnpm --filter @west4/api dev:test",
      // The simulated clock (server_time 10:41 PM after a seed load) needs the staging switch and the database.
      env: {
        WEST4_ENV: process.env["WEST4_ENV"] ?? "local",
        ALLOW_STAGING_FEATURES: process.env["ALLOW_STAGING_FEATURES"] ?? "true",
        DATABASE_URL: process.env["DATABASE_URL"] ?? "postgres://west4:west4@localhost:5432/west4",
        APP_DATABASE_URL:
          process.env["APP_DATABASE_URL"] ?? "postgres://app_rw:app_rw@localhost:5432/west4",
        // Passkeys (M1-19): the smoke test's page lives on the API's own origin.
        WEBAUTHN_RP_ID: process.env["WEBAUTHN_RP_ID"] ?? "localhost",
        WEBAUTHN_ORIGINS:
          process.env["WEBAUTHN_ORIGINS"] ?? "http://localhost:3000,http://localhost:5173",
        // Photos go straight from the browser to the local store (M2-21), as in the integration tests.
        S3_ENDPOINT: process.env["S3_ENDPOINT"] ?? "http://localhost:9000",
        S3_REGION: process.env["S3_REGION"] ?? "us-east-1",
        S3_ACCESS_KEY_ID: process.env["S3_ACCESS_KEY_ID"] ?? "west4",
        S3_SECRET_ACCESS_KEY: process.env["S3_SECRET_ACCESS_KEY"] ?? "west4secret",
        S3_BUCKET_FILES: process.env["S3_BUCKET_FILES"] ?? "west4-files",
      },
      url: "http://127.0.0.1:3000/v1/health",
      reuseExistingServer: !ci,
      timeout: 120_000,
    },
    {
      command: "pnpm --filter @west4/staff dev",
      url: "http://localhost:5173",
      reuseExistingServer: !ci,
      timeout: 120_000,
    },
    {
      command: "pnpm --filter @west4/console dev",
      url: "http://localhost:5174",
      reuseExistingServer: !ci,
      timeout: 120_000,
    },
    {
      command: "pnpm --filter @west4/guest dev",
      url: "http://localhost:3001",
      reuseExistingServer: !ci,
      timeout: 180_000,
    },
  ],
});
