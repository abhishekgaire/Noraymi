// @ts-check
// west4/no-jsx-literals (M1-21): no string literal reaches a staff screen
// outside the i18n catalogs. Words in JSX text, in a {"..."} child, or in an
// attribute a person can read (aria-label, title, placeholder, alt) fail lint.
// Punctuation and symbols on their own (" · ", "—", "→") are allowed, and so
// are attributes the screen never shows, like className, href, type or id.

const READABLE_ATTRIBUTES = new Set([
  "alt",
  "title",
  "placeholder",
  "label",
  "aria-label",
  "aria-description",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
]);

/** A string with a letter or a digit in it is a word someone can read. */
const hasWords = (text) => /[\p{L}\p{N}]/u.test(text);

/** @type {import("eslint").Rule.RuleModule} */
export const noJsxLiterals = {
  meta: {
    type: "problem",
    docs: { description: "Every string on a staff screen comes from the i18n catalog" },
    messages: {
      literal: 'Text on a staff screen must come from the catalog: use t("…") instead of {{text}}',
    },
    schema: [],
  },
  create(context) {
    const report = (node, text) =>
      context.report({ node, messageId: "literal", data: { text: JSON.stringify(text.trim()) } });
    const check = (node, raw) => {
      if (typeof raw === "string" && hasWords(raw)) report(node, raw);
    };
    return {
      JSXText(node) {
        check(node, node.value);
      },
      JSXExpressionContainer(node) {
        if (node.parent?.type !== "JSXElement" && node.parent?.type !== "JSXFragment") return;
        const e = node.expression;
        if (e.type === "Literal") check(node, e.value);
        if (e.type === "TemplateLiteral")
          for (const q of e.quasis) check(node, q.value.cooked ?? q.value.raw);
      },
      JSXAttribute(node) {
        const name = node.name.type === "JSXIdentifier" ? node.name.name : null;
        if (!name || !READABLE_ATTRIBUTES.has(name) || !node.value) return;
        if (node.value.type === "Literal") check(node, node.value.value);
        if (node.value.type === "JSXExpressionContainer") {
          const e = node.value.expression;
          if (e.type === "Literal") check(node, e.value);
          if (e.type === "TemplateLiteral")
            for (const q of e.quasis) check(node, q.value.cooked ?? q.value.raw);
        }
      },
    };
  },
};

export default { rules: { "no-jsx-literals": noJsxLiterals } };
