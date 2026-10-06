// @ts-check
// west4/live-views-only (M7-03): report and export code reads the live views
// (live_checks, live_check_lines, live_payments), never the base tables, so a
// practice check from training mode never reaches a Z report, tax, tips, an
// export or the reason-only totals. A SQL string in that code that reads
// `checks`, `check_lines` or `payments` after FROM or JOIN fails lint.

const BASE_READ = /\b(from|join)\s+(checks|check_lines|payments)\b/i;

/** @type {import("eslint").Rule.RuleModule} */
export const liveViewsOnly = {
  meta: {
    type: "problem",
    docs: { description: "Report and export code reads the live views, never the base tables" },
    messages: {
      base: "Report and export code reads {{table}} through live_{{table}}, so practice checks stay out",
    },
    schema: [],
  },
  create(context) {
    /** @param {import("estree").Node} node @param {unknown} text */
    const check = (node, text) => {
      if (typeof text !== "string") return;
      const m = BASE_READ.exec(text);
      if (m) context.report({ node, messageId: "base", data: { table: m[2].toLowerCase() } });
    };
    return {
      Literal(node) {
        check(node, node.value);
      },
      TemplateLiteral(node) {
        check(node, node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(" "));
      },
    };
  },
};

export default { rules: { "live-views-only": liveViewsOnly } };
