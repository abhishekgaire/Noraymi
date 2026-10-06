/**
 * The KJ's songbook CSV (M6-23; Song systems and texts · Songbook; D63): a header line naming the
 * title, artist and code columns (any order, any case; other columns are ignored), then one song a
 * line. Every row is checked, and a row that fails is reported with its line number in the file (the
 * line its record starts on), so "a missing title on line 12" says line 12. Quoted fields may hold
 * commas, doubled quotes and line breaks, as spreadsheets write them. Pure: no I/O.
 */
export interface SongbookRow {
  readonly title: string;
  readonly artist: string | null;
  readonly code: string | null;
}

export type SongbookProblem =
  | "not_utf8"
  | "no_header"
  | "missing_title"
  | "title_too_long"
  | "artist_too_long"
  | "code_too_long"
  | "unclosed_quote"
  | "no_songs"
  | "too_many_songs";

export interface SongbookError {
  /** 1-based line in the file; 0 for the file as a whole. */
  readonly line: number;
  readonly problem: SongbookProblem;
}

export const SONGBOOK_LIMITS = { title: 120, artist: 120, code: 40, songs: 100_000 } as const;

/** The file's bytes as text: UTF-8 (a byte-order mark is dropped), or null when it isn't UTF-8. */
export function songbookText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

/** CSV records with the line each starts on. */
function records(text: string): { line: number; fields: string[] }[] | { unclosedAt: number } {
  const out: { line: number; fields: string[] }[] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let start = 1;
  let fresh = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      fresh = false;
    } else if (ch === ",") {
      fields.push(field);
      field = "";
      fresh = false;
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      fields.push(field);
      if (!(fresh && fields.length === 1 && fields[0] === "")) out.push({ line: start, fields });
      fields = [];
      field = "";
      fresh = true;
      line++;
      start = line;
    } else {
      field += ch;
      fresh = false;
    }
  }
  if (quoted) return { unclosedAt: start };
  fields.push(field);
  if (!(fresh && fields.length === 1 && fields[0] === "")) out.push({ line: start, fields });
  return out;
}

/** Every row checked: the songs when all pass, else every failing row by line number. */
export function parseSongbook(
  text: string,
): { ok: true; songs: SongbookRow[] } | { ok: false; errors: SongbookError[] } {
  const all = records(text.startsWith("﻿") ? text.slice(1) : text);
  if (!Array.isArray(all))
    return { ok: false, errors: [{ line: all.unclosedAt, problem: "unclosed_quote" }] };
  const blank = (f: string[]) => f.every((x) => x.trim() === "");
  const rows = all.filter((r) => !blank(r.fields));
  const header = rows[0];
  const names = header?.fields.map((f) => f.trim().toLowerCase()) ?? [];
  const col = {
    title: names.indexOf("title"),
    artist: names.indexOf("artist"),
    code: names.indexOf("code"),
  };
  if (!header || col.title < 0 || col.artist < 0 || col.code < 0)
    return { ok: false, errors: [{ line: header?.line ?? 1, problem: "no_header" }] };
  const body = rows.slice(1);
  if (body.length === 0) return { ok: false, errors: [{ line: 0, problem: "no_songs" }] };
  if (body.length > SONGBOOK_LIMITS.songs)
    return { ok: false, errors: [{ line: 0, problem: "too_many_songs" }] };
  const songs: SongbookRow[] = [];
  const errors: SongbookError[] = [];
  const cell = (f: string[], i: number) => (f[i] ?? "").trim().replace(/\s+/g, " ");
  for (const r of body) {
    const title = cell(r.fields, col.title);
    const artist = cell(r.fields, col.artist);
    const code = cell(r.fields, col.code);
    const problem: SongbookProblem | null = !title
      ? "missing_title"
      : title.length > SONGBOOK_LIMITS.title
        ? "title_too_long"
        : artist.length > SONGBOOK_LIMITS.artist
          ? "artist_too_long"
          : code.length > SONGBOOK_LIMITS.code
            ? "code_too_long"
            : null;
    if (problem) errors.push({ line: r.line, problem });
    else songs.push({ title, artist: artist || null, code: code || null });
  }
  return errors.length ? { ok: false, errors } : { ok: true, songs };
}
