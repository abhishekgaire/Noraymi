/**
 * The tables and roles the migration linter protects. Keep this list in step
 * with the data model (spec 04) as tables land.
 */

/** Tables the API connects as. It never gets delete, truncate, references or trigger. */
export const APP_ROLE = "app_rw";

/**
 * The audited migration role that batched backfills run as (spec 13, Releases).
 * The spec doesn't name it; app_migrator is the cautious default chosen in M1-03.
 */
export const AUDITED_MIGRATION_ROLE = "app_migrator";

/** The money core (spec 04). Rows are only ever inserted, never updated or deleted by a migration. */
export const MONEY_TABLES: ReadonlySet<string> = new Set([
  "checks",
  "check_revisions",
  "check_lines",
  "payments",
  "payment_attempts",
  "payment_allocations",
  "payment_events",
  "refunds",
  "venue_counters",
  "drawer_moves",
  "tip_pools",
  "night_closes",
]);

/** Append-only tables: a new column must be nullable so old rows stay valid as written. */
export const APPEND_ONLY_TABLES: ReadonlySet<string> = new Set([
  "venue_settings",
  "audit_log",
  "venue_events",
  "webhook_events",
  "rule_pack_versions",
  ...MONEY_TABLES,
]);

/** A column that holds money. app_rw never gets update on one. */
export function isMoneyColumn(column: string): boolean {
  return /_cents$/.test(column) || column === "qty" || column === "amount";
}

/** The tenancy root: referenced by every venue table, itself not venue-owned. */
export const TENANCY_ROOT_TABLES: ReadonlySet<string> = new Set([
  "organizations",
  "venues",
  "users",
]);
