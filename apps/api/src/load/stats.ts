/**
 * The numbers a Friday-night load test reports (M8-21): percentiles by nearest rank (the 95th of 20
 * samples is the 19th smallest), so a reported p95 is always a time some order really took.
 */
export interface Summary {
  readonly count: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly max: number | null;
}

export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

export function summarize(samples: readonly number[]): Summary {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.length ? sorted[sorted.length - 1]! : null,
  };
}

/** The share of samples under the target (3 s means under 3,000 ms, as the alert counts), 0 to 1 (1 when there are none). */
export function shareWithin(samples: readonly number[], targetMs: number): number {
  if (samples.length === 0) return 1;
  return samples.filter((s) => s < targetMs).length / samples.length;
}

export const fmtMs = (ms: number | null) => (ms === null ? "–" : `${Math.round(ms)} ms`);
