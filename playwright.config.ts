import { defineConfig } from "@playwright/test";

const ci = !!process.env["CI"];

// One smoke test per app (M1-01). Each web app gets its dev server; the
// desktop test launches Electron itself and points it at the staff server.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
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
      command: "pnpm --filter @west4/api dev",
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
