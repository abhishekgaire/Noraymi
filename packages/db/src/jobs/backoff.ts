/**
 * Retry delay after a failed attempt: exponential from 5 seconds, capped at
 * 10 minutes, with ±25% jitter so a burst of failures doesn't retry in step.
 */
export const FIRST_RETRY_SECONDS = 5;
export const MAX_RETRY_SECONDS = 600;

export function retryDelaySeconds(attempt: number, random: () => number = Math.random): number {
  if (!Number.isInteger(attempt) || attempt < 1)
    throw new RangeError(`attempt must be >= 1, got ${String(attempt)}`);
  const base = Math.min(MAX_RETRY_SECONDS, FIRST_RETRY_SECONDS * 2 ** (attempt - 1));
  const jitter = 1 + (random() * 2 - 1) * 0.25;
  return Math.min(MAX_RETRY_SECONDS, Math.max(1, Math.round(base * jitter)));
}
