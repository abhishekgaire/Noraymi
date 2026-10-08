/**
 * The mapping file (version 1): how one source's export files map onto our
 * records. One mapping per source system and export layout; when West 4's
 * export changes, the mapping gets a new file, never a code change. The
 * format is documented in docs/runbooks/import.md.
 *
 *   {
 *     "mapping_version": 1,
 *     "source": "west4-rehearsal",
 *     "files": {
 *       "guests": { "file": "guests.csv", "columns": { "legacy_ref": "Customer ID", "name": "Name" } },
 *       "bookings": { "file": "bookings.csv", "columns": { ... }, "values": { "status": { "Seated": "checked_in" } } }
 *     }
 *   }
 */
export const MAPPING_VERSION = 1;

export const KINDS = [
  "guests",
  "people",
  "menu",
  "bookings",
  "consents",
  "nightly_totals",
] as const;
export type Kind = (typeof KINDS)[number];

/** Our fields per kind; the required ones must be mapped to a column (or given a default). */
export const FIELDS: Record<Kind, { required: readonly string[]; optional: readonly string[] }> = {
  guests: { required: ["legacy_ref", "name"], optional: ["phone", "email", "locale"] },
  people: { required: ["legacy_ref", "name", "role"], optional: ["email", "phone", "locale"] },
  menu: {
    required: ["legacy_ref", "name", "category", "price", "alcohol"],
    optional: ["button_name", "tax_category", "variant", "sort"],
  },
  bookings: {
    required: ["legacy_ref", "guest_ref", "room", "party_size", "starts_at", "ends_at"],
    optional: ["deposit", "status"],
  },
  consents: {
    required: ["guest_ref", "channel", "kind"],
    optional: ["legacy_ref", "given_at", "revoked_at", "revoked_via", "source", "text_version"],
  },
  nightly_totals: { required: ["business_date", "net_sales"], optional: ["rooms", "bar"] },
};

export interface FileMapping {
  readonly file: string;
  readonly format?: "csv" | "json";
  /** Our field → the export's column name. */
  readonly columns: Readonly<Record<string, string>>;
  /** Our field → (the export's value → ours). A value missing from a map is a problem. */
  readonly values?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Our field → the value to use when the export has no column for it. */
  readonly defaults?: Readonly<Record<string, string>>;
  /** Money columns in dollars ("$90.00", the default) or whole cents. */
  readonly money_unit?: "dollars" | "cents";
}

export interface Mapping {
  readonly mapping_version: number;
  /** Names the source and layout, e.g. "west4-oldsystem-2026-10". */
  readonly source: string;
  readonly description?: string;
  readonly files: Partial<Record<Kind, FileMapping>>;
}

/** Checks a parsed mapping file; returns the problems, empty when it's usable. */
export function checkMapping(raw: unknown): { mapping?: Mapping; problems: string[] } {
  const problems: string[] = [];
  if (typeof raw !== "object" || raw === null)
    return { problems: ["the mapping is not a JSON object"] };
  const m = raw as Record<string, unknown>;
  if (m["mapping_version"] !== MAPPING_VERSION) {
    problems.push(
      `mapping_version must be ${MAPPING_VERSION} (got ${JSON.stringify(m["mapping_version"])})`,
    );
  }
  if (typeof m["source"] !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(m["source"])) {
    problems.push("source must be a short lowercase name (letters, digits, . _ -)");
  }
  const files = m["files"];
  if (typeof files !== "object" || files === null || Object.keys(files).length === 0) {
    problems.push("files must name at least one kind");
    return { problems };
  }
  for (const [kind, fm] of Object.entries(files as Record<string, unknown>)) {
    if (!(KINDS as readonly string[]).includes(kind)) {
      problems.push(`files.${kind}: not a kind we import (${KINDS.join(", ")})`);
      continue;
    }
    const f = fm as Partial<FileMapping> | null;
    if (!f || typeof f.file !== "string" || f.file.includes("..") || f.file.startsWith("/")) {
      problems.push(`files.${kind}.file must be a file name next to the mapping`);
      continue;
    }
    const fields = FIELDS[kind as Kind];
    const known = new Set([...fields.required, ...fields.optional]);
    const columns = f.columns ?? {};
    for (const field of Object.keys(columns)) {
      if (!known.has(field))
        problems.push(`files.${kind}.columns.${field}: not a field of ${kind}`);
    }
    for (const field of fields.required) {
      if (!columns[field] && f.defaults?.[field] === undefined) {
        problems.push(`files.${kind}: ${field} needs a column or a default`);
      }
    }
    if (f.format && f.format !== "csv" && f.format !== "json") {
      problems.push(`files.${kind}.format must be csv or json`);
    }
    if (f.money_unit && f.money_unit !== "dollars" && f.money_unit !== "cents") {
      problems.push(`files.${kind}.money_unit must be dollars or cents`);
    }
  }
  return problems.length === 0 ? { mapping: raw as Mapping, problems } : { problems };
}
