import { defineConfig } from "vitest/config";

// Unit tests: every *.test.ts outside the integration suite. Integration tests
// (*.int.test.ts) need Postgres and run through vitest.integration.config.ts.
export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts", "apps/*/vitest.config.ts"],
  },
});
