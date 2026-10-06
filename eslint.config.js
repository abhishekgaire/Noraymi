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
    // The watchdog (M1-29) is a dependency-free CommonJS script the operating system runs.
    files: ["apps/desktop/watchdog/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "writable",
        process: "readonly",
        __dirname: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
      },
    },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    // The desktop preload (M1-28) is sandboxed CommonJS: require is the only way in.
    files: ["apps/desktop/src/**/*.cts"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    // The staff service worker (M1-22) and the singer's (M6-21) run in a worker scope, not a window.
    files: ["apps/staff/public/sw.js", "apps/guest/public/sing-sw.js"],
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
  {
    // Stripe (M4-01): only apps/api/src/stripe talks to Stripe, through its one client with the pinned
    // version, the service's key and the venue's account. Nothing else imports the Stripe SDK or calls
    // Stripe's API address. (Stripe.js in the guest payment page is the browser library, not the SDK.)
    files: ["**/*.{ts,tsx,js,mjs,cjs,cts}"],
    // The payment page's Content Security Policy names Stripe's hosts; it calls nothing (M4-15).
    ignores: ["apps/api/src/stripe/**", "apps/guest/pay-policy.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [{ name: "stripe", message: "Use the Stripe client in apps/api/src/stripe." }],
          patterns: [
            { group: ["stripe/*"], message: "Use the Stripe client in apps/api/src/stripe." },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/api\\.stripe\\.com/]",
          message: "Only apps/api/src/stripe calls Stripe.",
        },
        {
          selector: "TemplateElement[value.raw=/api\\.stripe\\.com/]",
          message: "Only apps/api/src/stripe calls Stripe.",
        },
      ],
    },
  },
  prettier,
);
