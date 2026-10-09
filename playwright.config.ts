import { defineConfig } from "@playwright/test";
import {
  API,
  API_LOCAL,
  APP_DB,
  CONSOLE,
  DB,
  GOOGLE,
  GUEST,
  isolated,
  PAY,
  PAY_HOST,
  ports,
  STAFF,
  STRIPE,
} from "./e2e/stack.js";

const ci = !!process.env["CI"];
// Servers already on the ports are reused locally, never in CI and never in isolated mode
// (E2E_ISOLATED=1, `pnpm e2e:isolated`): that stack starts its own, beside a running demo.
const reuseExistingServer = !ci && !isolated;

// One smoke test per app (M1-01). Each web app gets its dev server; the
// desktop test launches Electron itself and points it at the staff server.
// Every port, URL and the database come from e2e/stack.ts.
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
  // Isolated runs keep their own results, so they never clobber a default run's.
  ...(isolated ? { outputDir: "test-results/isolated" } : {}),
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "api", testMatch: /api\.spec\.ts/, use: { baseURL: API } },
    { name: "staff", testMatch: /staff\.spec\.ts/, use: { baseURL: STAFF } },
    { name: "console", testMatch: /console\.spec\.ts/, use: { baseURL: CONSOLE } },
    { name: "guest", testMatch: /guest\.spec\.ts/, use: { baseURL: GUEST } },
    { name: "desktop", testMatch: /desktop\.spec\.ts/ },
  ],
  webServer: [
    {
      // The fake Stripe (M4-01): no keys load in the smoke tests, so every Stripe call goes here.
      // In isolated mode its database is created (if missing) and migrated first.
      command: `${isolated ? "node scripts/e2e-db.mjs && " : ""}pnpm --filter @west4/api stripe:fake`,
      env: { STRIPE_FAKE_PORT: String(ports.stripe), STRIPE_FAKE_HOOKS: `${API}/v1/hooks/stripe` },
      url: `${STRIPE}/fake/health`,
      reuseExistingServer,
      timeout: 120_000,
    },
    {
      // The fake Google (M5-15): no Google client loads in the smoke tests, so Business Profile calls go here.
      command: "pnpm --filter @west4/api google:fake",
      env: { GOOGLE_FAKE_PORT: String(ports.google) },
      url: `${GOOGLE}/fake/health`,
      reuseExistingServer,
      timeout: 60_000,
    },
    {
      // dev:test never reads .env, so the smoke tests can't pick up real credentials.
      command: "pnpm --filter @west4/api dev:test",
      // The simulated clock (server_time 10:41 PM after a seed load) needs the staging switch and the database.
      env: {
        PORT: String(ports.api),
        WEST4_ENV: process.env["WEST4_ENV"] ?? "local",
        ALLOW_STAGING_FEATURES: process.env["ALLOW_STAGING_FEATURES"] ?? "true",
        DATABASE_URL: DB,
        APP_DATABASE_URL: APP_DB,
        // Passkeys (M1-19): the smoke test's page lives on the API's own origin.
        WEBAUTHN_RP_ID: process.env["WEBAUTHN_RP_ID"] ?? "localhost",
        WEBAUTHN_ORIGINS:
          (isolated ? undefined : process.env["WEBAUTHN_ORIGINS"]) ?? `${API_LOCAL},${STAFF}`,
        // Photos go straight from the browser to the local store (M2-21), as in the integration tests.
        S3_ENDPOINT: process.env["S3_ENDPOINT"] ?? "http://localhost:9000",
        S3_REGION: process.env["S3_REGION"] ?? "us-east-1",
        S3_ACCESS_KEY_ID: process.env["S3_ACCESS_KEY_ID"] ?? "west4",
        S3_SECRET_ACCESS_KEY: process.env["S3_SECRET_ACCESS_KEY"] ?? "west4secret",
        S3_BUCKET_FILES: process.env["S3_BUCKET_FILES"] ?? "west4-files",
        // Stripe's hosted pages send the owner back here (M4-01).
        STAFF_APP_URL: (isolated ? undefined : process.env["STAFF_APP_URL"]) ?? STAFF,
        CONSOLE_URL: CONSOLE,
        GUEST_APP_URL: GUEST,
        PAY_APP_URL: PAY,
        STRIPE_API_BASE: STRIPE,
        GOOGLE_API_BASE: GOOGLE,
      },
      url: `${API}/v1/health`,
      reuseExistingServer,
      timeout: 120_000,
    },
    {
      command: `pnpm --filter @west4/staff exec vite --port ${ports.staff} --strictPort`,
      env: { STAFF_API_URL: API },
      url: STAFF,
      reuseExistingServer,
      timeout: 120_000,
    },
    {
      command: `pnpm --filter @west4/console exec vite --port ${ports.console} --strictPort`,
      env: { CONSOLE_API_URL: API },
      url: CONSOLE,
      reuseExistingServer,
      timeout: 120_000,
    },
    {
      command: `pnpm --filter @west4/guest exec next dev --port ${ports.guest}`,
      env: {
        API_URL: API_LOCAL,
        PAY_HOST,
        // The isolated stack's live channel is on its own API port, and next dev locks its build
        // folder, so the isolated server builds beside a running demo's.
        ...(isolated
          ? { NEXT_PUBLIC_EVENTS_PORT: String(ports.api), NEXT_DIST_DIR: ".next-e2e" }
          : {}),
      },
      url: GUEST,
      reuseExistingServer,
      timeout: 180_000,
    },
  ],
});
