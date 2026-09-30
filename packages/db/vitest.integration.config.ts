import { defineConfig } from "vitest/config";

// Needs Postgres 16: `docker compose up -d`, or the CI service. Each test file
// creates its own throwaway database from DATABASE_URL's server.
export default defineConfig({
  test: {
    name: "db:integration",
    include: ["src/**/*.int.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
