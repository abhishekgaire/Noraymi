// @ts-check
import { it } from "vitest";
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { liveViewsOnly } from "./live-views-only.js";

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });

it("west4/live-views-only: report SQL reads the live views, never checks, check_lines or payments", () => {
  tester.run("live-views-only", liveViewsOnly, {
    valid: [
      'const a = "select * from live_checks where venue_id = $1";',
      "const b = `select sum(amount_cents) from live_check_lines l join live_checks k on k.id = l.check_id`;",
      'const c = "select * from live_payments";',
      'const d = "select * from check_splits";',
      'const e = "the checks from tonight";',
    ],
    invalid: [
      { code: 'const a = "select * from checks";', errors: [{ messageId: "base" }] },
      {
        code: "const b = `select 1 from live_check_lines l join checks k on k.id = l.check_id`;",
        errors: [{ messageId: "base" }],
      },
      {
        code: "const c = `select ${cols} FROM payments where venue_id = $1`;",
        errors: [{ messageId: "base" }],
      },
      { code: 'const d = "select 1 from check_lines";', errors: [{ messageId: "base" }] },
    ],
  });
});
