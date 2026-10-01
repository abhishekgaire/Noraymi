import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "staff", include: ["src/**/*.test.ts", "src/**/*.test.tsx"] },
});
