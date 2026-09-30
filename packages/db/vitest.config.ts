import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "db", include: ["src/**/*.test.ts"], exclude: ["src/**/*.int.test.ts"] },
});
