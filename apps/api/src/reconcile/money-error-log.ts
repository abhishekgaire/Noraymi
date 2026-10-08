import type { MoneyAudit } from "./audit.js";

/**
 * The money-error log's rows (docs/gate/money-errors.md, M9-15): one per error, with the night, the
 * venue, what differed and by how much. The cause, the fix and who signed it off are for a person.
 */
export function moneyErrorRows(venueId: string, audit: MoneyAudit): string {
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  return audit.errors
    .map(
      (e) =>
        `| ${audit.night} | ${venueId} | ${e.kind} | ${cell(e.ref ?? "")} | ${cell(e.detail)} | ${
          e.diffCents ?? ""
        } |  |  |  |\n`,
    )
    .join("");
}
