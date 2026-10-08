import { createHash } from "node:crypto";
import { parseCsv, CsvError } from "./csv.js";
import { FIELDS, KINDS, type FileMapping, type Kind, type Mapping } from "./mapping.js";
import {
  containsCardNumber,
  parseCents,
  parseDate,
  parseEmail,
  parseInstant,
  parsePhone,
  parseWholeNumber,
  parseYesNo,
  sensitiveHeader,
  type Parsed,
} from "./values.js";

/**
 * Reading the export files into records, before anything touches the
 * database: the refusal scan for PINs and card numbers, then every row's
 * values, each problem named by file and line.
 */
export interface Problem {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

export interface Refusal {
  readonly file: string;
  readonly line: number;
  readonly column: string;
  readonly why: "pin" | "card";
}

/** A file with a PIN or card-number column, or a card number in any cell: nothing loads. */
export class ImportRefused extends Error {
  constructor(readonly refusals: readonly Refusal[]) {
    super(
      "refused before anything loaded: " +
        refusals
          .map((r) =>
            r.why === "pin"
              ? `${r.file}:${r.line} column "${r.column}" looks like a PIN`
              : `${r.file}:${r.line} column "${r.column}" looks like a card number`,
          )
          .join("; "),
    );
  }
}

interface Base {
  readonly file: string;
  readonly line: number;
  readonly legacyRef: string;
  /** sha256 of the record's values: a re-run compares it to spot changes in the old system. */
  readonly hash: string;
}
export interface GuestRecord extends Base {
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly locale: "en" | "es" | null;
}
export interface PersonRecord extends Base {
  readonly name: string;
  readonly role: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly locale: "en" | "es" | null;
}
export interface MenuRecord extends Base {
  readonly name: string;
  readonly category: string;
  readonly priceCents: number;
  readonly alcohol: boolean;
  readonly buttonName: string | null;
  readonly taxCategory: string;
  readonly variant: string;
  readonly sort: number;
}
export interface PolicyRecord extends Base {
  readonly text: string;
  /** Hours before the start a guest may cancel for a refund, as the old terms said; null when they don't say. */
  readonly refundHours: number | null;
  readonly publishedAt: string | null;
}
export interface BookingRecord extends Base {
  readonly guestRef: string;
  readonly room: string;
  readonly partySize: number;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly depositCents: number;
  readonly status: string;
  readonly policyRef: string | null;
  readonly acceptedAt: string | null;
}
export interface ConsentRecord extends Base {
  readonly guestRef: string;
  readonly channel: "sms" | "email";
  readonly kind: "texts" | "marketing";
  readonly givenAt: string | null;
  readonly revokedAt: string | null;
  readonly revokedVia: string | null;
  readonly source: string;
  readonly textVersion: string | null;
}
export interface NightlyTotalRecord extends Base {
  readonly businessDate: string;
  readonly netSalesCents: number;
  readonly roomsCents: number;
  readonly barCents: number;
}

export interface Prepared {
  readonly mapping: Mapping;
  readonly files: readonly { kind: Kind; file: string; sha256: string; records: number }[];
  readonly guests: readonly GuestRecord[];
  readonly people: readonly PersonRecord[];
  readonly menu: readonly MenuRecord[];
  readonly policies: readonly PolicyRecord[];
  readonly bookings: readonly BookingRecord[];
  readonly consents: readonly ConsentRecord[];
  readonly nightlyTotals: readonly NightlyTotalRecord[];
  readonly problems: readonly Problem[];
}

const ROLES = new Set(["owner", "manager", "bartender", "front_desk", "staff"]);
const BOOKING_STATUSES = new Set([
  "pending",
  "confirmed",
  "checked_in",
  "no_show",
  "cancelled",
  "completed",
]);
const REVOKED_VIA = new Set(["keyword", "staff", "guest_page"]);

interface RawRow {
  readonly line: number;
  readonly get: (column: string) => string | undefined;
}

/** Parses one file's text into rows, or throws a CsvError; JSON rows are numbered from 1. */
function rowsOf(text: string, format: "csv" | "json"): { header: string[]; rows: RawRow[] } {
  if (format === "json") {
    const data: unknown = JSON.parse(text);
    const list = Array.isArray(data) ? data : [];
    const header = new Set<string>();
    const rows = list.map((o: unknown, i) => {
      const obj = (typeof o === "object" && o !== null ? o : {}) as Record<string, unknown>;
      for (const k of Object.keys(obj)) header.add(k);
      return {
        line: i + 1,
        get: (c: string) => {
          const v = obj[c];
          return v === undefined || v === null ? undefined : String(v);
        },
      };
    });
    return { header: [...header], rows };
  }
  const t = parseCsv(text);
  const index = new Map(t.header.map((h, i) => [h, i]));
  return {
    header: [...t.header],
    rows: t.records.map((r) => ({
      line: r.line,
      get: (c: string) => {
        const i = index.get(c);
        return i === undefined ? undefined : r.cells[i];
      },
    })),
  };
}

const hashOf = (v: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(v, Object.keys(v as object).sort()))
    .digest("hex");

/**
 * Reads every file the mapping names. `read` returns a file's text by its
 * name; `timeZone` is the venue's, for local times in the export.
 * Throws ImportRefused when any file carries a PIN or card number.
 */
export function prepareImport(
  mapping: Mapping,
  read: (file: string) => string,
  timeZone: string,
): Prepared {
  const parsed = new Map<Kind, { fm: FileMapping; header: string[]; rows: RawRow[] }>();
  const problems: Problem[] = [];
  const refusals: Refusal[] = [];
  const files: { kind: Kind; file: string; sha256: string; records: number }[] = [];

  // 1. Read every file and scan it whole for PINs and card numbers, before any row is used.
  for (const kind of KINDS) {
    const fm = mapping.files[kind];
    if (!fm) continue;
    const text = read(fm.file);
    const format = fm.format ?? (fm.file.toLowerCase().endsWith(".json") ? "json" : "csv");
    let header: string[];
    let rows: RawRow[];
    try {
      ({ header, rows } = rowsOf(text, format));
    } catch (e) {
      problems.push({
        file: fm.file,
        line: e instanceof CsvError ? e.line : 0,
        message: `can't be read: ${(e as Error).message}`,
      });
      continue;
    }
    for (const h of header) {
      const why = sensitiveHeader(h);
      if (why) refusals.push({ file: fm.file, line: format === "csv" ? 1 : 0, column: h, why });
    }
    for (const r of rows) {
      for (const h of header) {
        const v = r.get(h);
        if (v !== undefined && containsCardNumber(v)) {
          refusals.push({ file: fm.file, line: r.line, column: h, why: "card" });
        }
      }
    }
    for (const field of Object.keys(fm.columns)) {
      const col = fm.columns[field]!;
      if (!header.includes(col)) {
        problems.push({ file: fm.file, line: 1, message: `has no column "${col}" (for ${field})` });
      }
    }
    files.push({
      kind,
      file: fm.file,
      sha256: createHash("sha256").update(text).digest("hex"),
      records: rows.length,
    });
    parsed.set(kind, { fm, header, rows });
  }
  if (refusals.length > 0) throw new ImportRefused(refusals);

  // 2. Each row's values.
  const out = {
    guests: [] as GuestRecord[],
    people: [] as PersonRecord[],
    menu: [] as MenuRecord[],
    policies: [] as PolicyRecord[],
    bookings: [] as BookingRecord[],
    consents: [] as ConsentRecord[],
    nightlyTotals: [] as NightlyTotalRecord[],
  };
  for (const [kind, { fm, rows }] of parsed) {
    const seen = new Map<string, number>();
    for (const row of rows) {
      const rowProblems: string[] = [];
      const field = (name: string): string | undefined => {
        const col = fm.columns[name];
        let v = col ? row.get(col)?.trim() : undefined;
        if ((v === undefined || v === "") && fm.defaults?.[name] !== undefined)
          v = fm.defaults[name];
        if (v === undefined || v === "") {
          if (FIELDS[kind].required.includes(name)) rowProblems.push(`${name} is empty`);
          return undefined;
        }
        const map = fm.values?.[name];
        if (map) {
          const key = Object.keys(map).find((k) => k.trim().toLowerCase() === v!.toLowerCase());
          if (key === undefined) {
            rowProblems.push(`${name} "${v}" isn't in the mapping's values`);
            return undefined;
          }
          return map[key];
        }
        return v;
      };
      const take = <T>(name: string, p: Parsed<T> | undefined): T | undefined => {
        if (!p) return undefined;
        if (!p.ok) {
          rowProblems.push(`${name} ${p.reason}`);
          return undefined;
        }
        return p.value;
      };
      const opt = <T>(name: string, parse: (s: string) => Parsed<T>): T | null => {
        const v = field(name);
        return v === undefined ? null : (take(name, parse(v)) ?? null);
      };
      const req = <T>(name: string, parse: (s: string) => Parsed<T>): T | undefined => {
        const v = field(name);
        return v === undefined ? undefined : take(name, parse(v));
      };
      const text = (name: string, max = 200): string | undefined => {
        const v = field(name);
        if (v !== undefined && v.length > max) {
          rowProblems.push(`${name} is longer than ${max} characters`);
          return undefined;
        }
        return v;
      };
      const oneOf = (name: string, allowed: Set<string>): string | undefined => {
        const v = field(name);
        if (v !== undefined && !allowed.has(v)) {
          rowProblems.push(`${name} "${v}" must be one of ${[...allowed].join(", ")}`);
          return undefined;
        }
        return v;
      };
      const locale = (): "en" | "es" | null => {
        const v = field("locale");
        if (v === undefined) return null;
        const l = v.toLowerCase();
        if (["en", "english", "en-us"].includes(l)) return "en";
        if (["es", "spanish", "español", "espanol", "es-us"].includes(l)) return "es";
        rowProblems.push(`locale "${v}" must be en or es`);
        return null;
      };
      const money = (s: string) => parseCents(s, fm.money_unit ?? "dollars");
      const nonNegative = (name: string, v: number | null | undefined) => {
        if (typeof v === "number" && v < 0) rowProblems.push(`${name} is below zero`);
      };
      const at = (s: string) => parseInstant(s, timeZone);

      let record: Record<string, unknown> | undefined;
      let ref: string | undefined;
      if (kind === "guests") {
        ref = text("legacy_ref");
        record = {
          name: text("name", 120),
          phone: opt("phone", parsePhone),
          email: opt("email", parseEmail),
          locale: locale(),
        };
      } else if (kind === "people") {
        ref = text("legacy_ref");
        record = {
          name: text("name", 120),
          role: oneOf("role", ROLES),
          email: opt("email", parseEmail),
          phone: opt("phone", parsePhone),
          locale: locale(),
        };
      } else if (kind === "menu") {
        ref = text("legacy_ref");
        const priceCents = req("price", money);
        nonNegative("price", priceCents);
        const buttonName = text("button_name", 24) ?? null;
        record = {
          name: text("name", 120),
          category: text("category", 80),
          priceCents,
          alcohol: req("alcohol", parseYesNo),
          buttonName,
          taxCategory: text("tax_category", 40) ?? "drink",
          variant: text("variant", 60) ?? "Regular",
          sort: opt("sort", (s) => parseWholeNumber(s, 0, 100000)) ?? row.line,
        };
      } else if (kind === "policies") {
        ref = text("legacy_ref");
        record = {
          text: text("text", 5000),
          refundHours: opt("refund_hours", (s) => parseWholeNumber(s, 0, 24 * 365)),
          publishedAt: opt("published_at", at)?.toString() ?? null,
        };
      } else if (kind === "bookings") {
        ref = text("legacy_ref");
        const startsAt = req("starts_at", at);
        const endsAt = req("ends_at", at);
        if (startsAt && endsAt && endsAt.epochMilliseconds <= startsAt.epochMilliseconds) {
          rowProblems.push("ends_at is not after starts_at");
        }
        const depositCents = opt("deposit", money) ?? 0;
        nonNegative("deposit", depositCents);
        record = {
          guestRef: text("guest_ref"),
          room: text("room", 80),
          partySize: req("party_size", (s) => parseWholeNumber(s, 1, 500)),
          startsAt: startsAt?.toString(),
          endsAt: endsAt?.toString(),
          depositCents,
          status: oneOf("status", BOOKING_STATUSES) ?? "confirmed",
          policyRef: text("policy_ref") ?? null,
          acceptedAt: opt("accepted_at", at)?.toString() ?? null,
        };
      } else if (kind === "consents") {
        const channel = oneOf("channel", new Set(["sms", "email"]));
        const ckind = oneOf("kind", new Set(["texts", "marketing"]));
        const givenAt = opt("given_at", at);
        const revokedAt = opt("revoked_at", at);
        const revokedVia = oneOf("revoked_via", REVOKED_VIA) ?? null;
        if (!givenAt && !revokedAt) rowProblems.push("has neither given_at nor revoked_at");
        if (revokedAt && !revokedVia) rowProblems.push("revoked_at needs revoked_via");
        if (!revokedAt && revokedVia) rowProblems.push("revoked_via needs revoked_at");
        const guestRef = text("guest_ref");
        record = {
          guestRef,
          channel,
          kind: ckind,
          givenAt: givenAt?.toString() ?? null,
          revokedAt: revokedAt?.toString() ?? null,
          revokedVia,
          source: text("source", 200) ?? `import:${mapping.source}`,
          textVersion: text("text_version", 200) ?? null,
        };
        ref =
          text("legacy_ref") ??
          [guestRef, channel, ckind, givenAt ?? "", revokedAt ?? ""].join("|");
      } else {
        const businessDate = req("business_date", parseDate);
        const net = req("net_sales", money);
        const rooms = opt("rooms", money) ?? 0;
        const bar = opt("bar", money) ?? 0;
        record = { businessDate, netSalesCents: net, roomsCents: rooms, barCents: bar };
        ref = businessDate;
      }

      if (ref !== undefined) {
        const first = seen.get(ref);
        if (first !== undefined) rowProblems.push(`repeats the record on line ${first}`);
        else seen.set(ref, row.line);
      }
      if (rowProblems.length > 0 || ref === undefined) {
        for (const message of rowProblems)
          problems.push({ file: fm.file, line: row.line, message });
        continue;
      }
      const full = {
        ...record,
        file: fm.file,
        line: row.line,
        legacyRef: ref,
        hash: hashOf(record),
      };
      const target =
        kind === "nightly_totals" ? out.nightlyTotals : (out[kind] as unknown as unknown[]);
      target.push(full);
    }
  }

  return { mapping, files, ...out, problems };
}
