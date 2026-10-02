import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "guest", include: ["*.test.ts", "app/**/*.test.ts"] },
});
