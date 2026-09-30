/**
 * Splits a migration file into statements, dropping comments and keeping the
 * line each statement starts on, so a finding can name the file and the line.
 * Handles 'strings', "identifiers", $$dollar quotes$$, -- and block comments.
 */
export interface Statement {
  /** The statement's text, comments removed, whitespace collapsed, lower-cased. */
  readonly text: string;
  /** 1-based line of the statement's first token in the file. */
  readonly line: number;
}

export function splitStatements(source: string): Statement[] {
  const statements: Statement[] = [];
  let buffer = "";
  let line = 1;
  let startLine = 0;
  let i = 0;
  const n = source.length;

  const push = (): void => {
    const text = normalize(buffer);
    if (text !== "") statements.push({ text, line: startLine });
    buffer = "";
    startLine = 0;
  };

  while (i < n) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (ch === "-" && next === "-") {
      while (i < n && source[i] !== "\n") i += 1;
      buffer += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") line += 1;
        i += 1;
      }
      i += 2;
      buffer += " ";
      continue;
    }
    if (ch === "'" || ch === '"') {
      if (startLine === 0) startLine = line;
      const quote = ch;
      let j = i + 1;
      buffer += ch;
      while (j < n) {
        const c = source[j]!;
        buffer += c;
        if (c === "\n") line += 1;
        if (c === quote) {
          if (source[j + 1] === quote) {
            buffer += quote;
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      i = j + 1;
      continue;
    }
    if (ch === "$") {
      const tag = /^\$[a-zA-Z_]*\$/.exec(source.slice(i, i + 64));
      if (tag) {
        if (startLine === 0) startLine = line;
        const open = tag[0];
        const close = source.indexOf(open, i + open.length);
        const end = close === -1 ? n : close + open.length;
        const chunk = source.slice(i, end);
        line += (chunk.match(/\n/g) ?? []).length;
        buffer += chunk;
        i = end;
        continue;
      }
    }
    if (ch === ";") {
      push();
      i += 1;
      continue;
    }
    if (ch === "\n") line += 1;
    if (startLine === 0 && !/\s/.test(ch)) startLine = line;
    buffer += ch;
    i += 1;
  }
  push();
  return statements;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Strip a schema prefix and quotes: public."checks" → checks. */
export function tableName(raw: string): string {
  const parts = raw.split(".");
  return (parts[parts.length - 1] ?? raw).replace(/"/g, "");
}

/** Split "a, b (c, d), e" at top-level commas. */
export function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") parts.push(current.trim());
  return parts;
}

/** The text between the first "(" after `from` and its matching ")". */
export function parenBody(text: string, from = 0): { body: string; end: number } | undefined {
  const open = text.indexOf("(", from);
  if (open === -1) return undefined;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return { body: text.slice(open + 1, i), end: i + 1 };
    }
  }
  return undefined;
}

export function columnList(text: string): string[] {
  return text
    .split(",")
    .map((c) => c.trim().replace(/"/g, ""))
    .filter((c) => c !== "");
}
