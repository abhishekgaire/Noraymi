// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import west4 from "./eslint-rules/no-jsx-literals.js";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/out/**",
      "**/.next/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "design/**",
      "scripts/**",
      "**/next-env.d.ts",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    // The desktop preload (M1-28) is sandboxed CommonJS: require is the only way in.
    files: ["apps/desktop/src/**/*.cts"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    // The staff service worker (M1-22) runs in a worker scope, not a window.
    files: ["apps/staff/public/sw.js"],
    languageOptions: {
      globals: { self: "readonly", caches: "readonly", fetch: "readonly", URL: "readonly" },
    },
  },
  {
    // Staff screens (M1-21): every word comes from the catalog, never from code.
    files: ["apps/staff/src/**/*.tsx"],
    plugins: { west4 },
    rules: { "west4/no-jsx-literals": "error" },
  },
  prettier,
);
