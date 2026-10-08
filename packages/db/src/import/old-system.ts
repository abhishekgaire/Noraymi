import { dollars, type ImportReport } from "./load.js";
import { parseCents } from "./values.js";

/**
 * M9-06: the dry run's proof that nothing is lost. The venue's old system
 * gives its own totals (a report or screen taken on the day of the export,
 * never the export file itself), typed into a small JSON file; the dry run's
 * saved records are compared with them in count and to the cent, and a
 * written report is made for the owner to sign (docs/gate/).
 */
export interface OldSystemTotals {
  /** Which of the old system's own reports or screens these come from. */
  readonly taken_from: string;
  /** When it was taken (the day of the export), as written on it. */
  readonly taken_at: string;
  readonly bookings: number;
  readonly deposit_cents: number;
  readonly consents: number;
  /** Optional: the old system's guest count, when its report shows one. */
  readonly guests?: number;
}

export function checkOldSystemTotals(raw: unknown): {
  totals?: OldSystemTotals;
  problems: string[];
} {
  const problems: string[] = [];
  if (typeof raw !== "object" || raw === null) return { problems: ["must be a JSON object"] };
  const o = raw as Record<string, unknown>;
  const text = (k: string) => {
    const v = o[k];
    if (typeof v !== "string" || v.trim() === "") problems.push(`"${k}" is required`);
    return typeof v === "string" ? v.trim() : "";
  };
  const count = (k: string, required: boolean) => {
    const v = o[k];
    if (v === undefined && !required) return undefined;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      problems.push(`"${k}" must be a whole number of records`);
      return 0;
    }
    return v;
  };
  const takenFrom = text("taken_from");
  const takenAt = text("taken_at");
  const bookings = count("bookings", true)!;
  const consents = count("consents", true)!;
  const guests = count("guests", false);
  let depositCents = 0;
  // Deposits as the old report prints them ("$990.00"); never a float.
  if (typeof o.deposits !== "string") problems.push('"deposits" is required, as "$1,234.50"');
  else {
    const c = parseCents(o.deposits, "dollars");
    if (c.ok) depositCents = c.value;
    else problems.push(`"deposits": ${c.reason}`);
  }
  if (problems.length > 0) return { problems };
  return {
    totals: {
      taken_from: takenFrom,
      taken_at: takenAt,
      bookings,
      deposit_cents: depositCents,
      consents,
      ...(guests !== undefined ? { guests } : {}),
    },
    problems,
  };
}

export interface ComparisonRow {
  readonly what: string;
  readonly old_system: string;
  readonly saved: string;
  readonly matches: boolean;
  readonly note?: string;
}

export interface Comparison {
  readonly rows: readonly ComparisonRow[];
  /** True when every row matches and the import itself reconciles. */
  readonly matches: boolean;
}

/** The dry run's saved records against the old system's own totals. */
export function compareWithOldSystem(r: ImportReport, t: OldSystemTotals): Comparison {
  const b = r.kinds.bookings;
  const savedBookings = b?.in_db ?? 0;
  const savedCents = b?.cents_in_db ?? 0;
  // A marketing opt-in without its proof is listed by name, never consent (M9-03): it's
  // accounted for, not lost, and the row says how many.
  const savedConsents = (r.kinds.consents?.in_db ?? 0) + r.consents.dropped_no_proof;
  const rows: ComparisonRow[] = [
    {
      what: "Bookings",
      old_system: String(t.bookings),
      saved: String(savedBookings),
      matches: t.bookings === savedBookings,
      ...(r.no_room.length > 0
        ? { note: `${r.no_room.length} on the manager's list (fit no room), deposit and all` }
        : {}),
    },
    {
      what: "Deposits",
      old_system: dollars(t.deposit_cents),
      saved: dollars(savedCents),
      matches: t.deposit_cents === savedCents,
    },
    {
      what: "Consents",
      old_system: String(t.consents),
      saved: String(savedConsents),
      matches: t.consents === savedConsents,
      ...(r.consents.dropped_no_proof > 0
        ? {
            note: `${r.consents.dropped_no_proof} marketing opt-in(s) without proof listed, not imported as consent`,
          }
        : {}),
    },
  ];
  if (t.guests !== undefined) {
    const g = r.kinds.guests?.in_db ?? 0;
    rows.push({
      what: "Guests",
      old_system: String(t.guests),
      saved: String(g),
      matches: t.guests === g,
    });
  }
  return { rows, matches: r.reconciles && rows.every((x) => x.matches) };
}

/** The comparison as lines for the terminal. */
export function formatComparison(c: Comparison): string[] {
  return [
    ...c.rows.map(
      (x) =>
        `${x.matches ? "match" : "DIFFERENT"} · ${x.what}: old system ${x.old_system}, saved ${x.saved}${x.note ? ` (${x.note})` : ""}`,
    ),
    c.matches
      ? "Matches the old system in count and to the cent."
      : "Does NOT match the old system: fix every difference and run the dry run again.",
  ];
}

/**
 * The written report for the owner to sign, kept in docs/gate/ as gate item 3's
 * evidence. It holds counts and cents only: no guest's name, number or email.
 */
export function dryRunReportMarkdown(
  r: ImportReport,
  t: OldSystemTotals,
  c: Comparison,
  reportLines: readonly string[],
): string {
  const cell = (s: string) => s.replace(/\|/g, "\\|");
  return [
    `# Import dry run ${r.run_id}`,
    "",
    `Mode: ${r.mode === "dry_run" ? "dry run (everything rolled back)" : "live import"} · mapping ${r.mapping.source} v${r.mapping.version} · cutover date ${r.deposits.cutover_date}`,
    "",
    `The old system's own totals: ${cell(t.taken_from)}, taken ${cell(t.taken_at)}.`,
    "",
    "| | Old system | Saved | |",
    "| --- | --- | --- | --- |",
    ...c.rows.map(
      (x) =>
        `| ${x.what} | ${x.old_system} | ${x.saved} | ${x.matches ? "Match" : "**Different**"}${x.note ? ` · ${cell(x.note)}` : ""} |`,
    ),
    "",
    c.matches
      ? "**Result: matches the old system in count and to the cent.**"
      : "**Result: does NOT match. Fix every difference and run the dry run again; this report can't be signed.**",
    "",
    "## The import's own report",
    "",
    "```",
    ...reportLines,
    "```",
    "",
    "## Sign-off",
    "",
    "I compared these totals with my old system's own report and they match.",
    "",
    "- Owner's name: ____________________",
    "- Signature: ____________________",
    "- Date: ____________________",
    "",
  ].join("\n");
}
