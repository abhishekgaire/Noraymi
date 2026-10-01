// @ts-check
import { it } from "vitest";
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { noJsxLiterals } from "./no-jsx-literals.js";

const tester = new RuleTester({
  languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
});

it("west4/no-jsx-literals: words in staff JSX fail, catalog strings and symbols pass", () => {
  tester.run("no-jsx-literals", noJsxLiterals, {
    valid: [
      'const a = <h1>{t("signIn.title")}</h1>;',
      'const b = <button aria-label={t("menu.open")}>☰</button>;',
      'const c = <p className="muted" id="x">{name} · {t("role.owner")}</p>;',
      "const d = <span> — </span>;",
      'const e = <input type="email" autoComplete="username" />;',
    ],
    invalid: [
      { code: "const a = <h1>Sign in</h1>;", errors: [{ messageId: "literal" }] },
      { code: 'const b = <p>{"Loading…"}</p>;', errors: [{ messageId: "literal" }] },
      {
        code: 'const c = <button aria-label="Open the menu">☰</button>;',
        errors: [{ messageId: "literal" }],
      },
      { code: 'const d = <input placeholder="Email" />;', errors: [{ messageId: "literal" }] },
      { code: "const e = <p>{`Room ${n}`}</p>;", errors: [{ messageId: "literal" }] },
    ],
  });
});
