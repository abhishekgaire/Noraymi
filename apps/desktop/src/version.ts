/**
 * min_client_version (M1-28): every API answer names the oldest build it
 * still serves. An older build keeps working tonight and updates between
 * business days (M1-29); this only says whether ours is below the line.
 */
export function isBelowMinimum(ours: string, minimum: string): boolean {
  const a = ours.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const b = minimum.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}
