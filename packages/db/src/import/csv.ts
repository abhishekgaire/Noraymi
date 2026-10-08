/**
 * A small RFC 4180 reader for the old system's CSV exports: quoted fields,
 * doubled quotes, commas and line breaks inside quotes, CRLF or LF, and a
 * leading byte-order mark. Each record keeps the line it starts on, so a
 * problem report can name the file and line.
 */
export interface CsvRecord {
  readonly line: number;
  readonly cells: readonly string[];
}

export interface CsvTable {
  readonly header: readonly string[];
  readonly records: readonly CsvRecord[];
}

export class CsvError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(message);
  }
}

export function parseCsv(text: string): CsvTable {
  const src = text.startsWith("﻿") ? text.slice(1) : text;
  const rows: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  let i = 0;
  const endCell = () => {
    cells.push(cell);
    cell = "";
  };
  const endRow = () => {
    endCell();
    if (!(cells.length === 1 && cells[0] === "")) rows.push({ line: rowLine, cells });
    cells = [];
  };
  while (i < src.length) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      if (ch === "\n") line += 1;
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (cell !== "") throw new CsvError(line, "a quote in the middle of a field");
      quoted = true;
      i += 1;
    } else if (ch === ",") {
      endCell();
      i += 1;
    } else if (ch === "\r" || ch === "\n") {
      endRow();
      i += ch === "\r" && src[i + 1] === "\n" ? 2 : 1;
      line += 1;
      rowLine = line;
    } else {
      cell += ch;
      i += 1;
    }
  }
  if (quoted) throw new CsvError(rowLine, "a quoted field never ends");
  if (cell !== "" || cells.length > 0) endRow();
  const [head, ...records] = rows;
  if (!head) return { header: [], records: [] };
  return { header: head.cells.map((h) => h.trim()), records };
}

/** Writes rows as CSV, quoting only where needed (the rehearsal export uses it). */
export function toCsv(rows: readonly (readonly string[])[]): string {
  const q = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map((r) => r.map(q).join(",")).join("\n") + "\n";
}
