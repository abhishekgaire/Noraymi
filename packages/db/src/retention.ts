/**
 * How long each kind of row is kept (Security and data retention · How long
 * we keep things), for M8's retention job: nothing on this list is removed
 * before its time, and the app itself never deletes these rows (the grants
 * test, M7-20). `years` is the minimum.
 */
export interface Retention {
  readonly table: string;
  readonly years: number;
  readonly why: string;
}

const WAGES = "New York's hospitality wage records (GA-M2)";
const CHECKS = "New York's record-keeping for guest checks (GA-M4)";

export const RETENTION: readonly Retention[] = [
  // GA-M2: the tip ledger, pools, shares, punches and shifts, 6 years.
  { table: "tip_ledger", years: 6, why: WAGES },
  { table: "tip_pools", years: 6, why: WAGES },
  { table: "tip_pool_occupations", years: 6, why: WAGES },
  { table: "tip_shares", years: 6, why: WAGES },
  { table: "time_punches", years: 6, why: WAGES },
  { table: "shifts", years: 6, why: WAGES },
  { table: "audit_log", years: 6, why: "Explains the records above" },
  // GA-M4: the money core and the nights, at least 3 years.
  { table: "checks", years: 3, why: CHECKS },
  { table: "check_lines", years: 3, why: CHECKS },
  { table: "check_revisions", years: 3, why: CHECKS },
  { table: "payments", years: 3, why: CHECKS },
  { table: "payment_allocations", years: 3, why: CHECKS },
  { table: "payment_events", years: 3, why: CHECKS },
  { table: "refunds", years: 3, why: CHECKS },
  { table: "night_closes", years: 3, why: CHECKS },
  { table: "drawer_sessions", years: 3, why: CHECKS },
  { table: "drawer_moves", years: 3, why: CHECKS },
  { table: "payouts", years: 3, why: CHECKS },
  { table: "payout_lines", years: 3, why: CHECKS },
  { table: "exports", years: 3, why: CHECKS },
];
