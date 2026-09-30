import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "rules", include: ["src/**/*.test.ts"] },
});
