import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*/vitest.integration.config.ts", "apps/*/vitest.integration.config.ts"],
  },
});
