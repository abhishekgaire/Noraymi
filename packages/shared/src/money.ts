/**
 * Money is an integer number of cents, never a float (spec conventions;
 * Money rules 1). Percentages round half up to the cent on exact values, and a
 * divided amount hands its leftover cents to the largest remainders, ties to
 * the first parts, so the parts always add up.
 */
export type Cents = number & { readonly __brand: "cents" };

export interface Money {
  readonly amount: Cents;
  readonly currency: "usd";
}

/** Check that a number is a whole, safe number of cents. The only way to make a Cents. */
export function cents(value: number): Cents {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`money must be an integer number of cents, got ${String(value)}`);
  }
  return value as Cents;
}

export function usd(amount: Cents): Money {
  return { amount, currency: "usd" };
}

/**
 * A percentage of a total, rounded half up to the cent on the exact value:
 * floor((2 × amount × num + den) / (2 × den)). 8.875% is num 8875, den 100000.
 * Only for a non-negative base: comps, voids and reversals are exact negatives
 * of stored lines and are never rounded (Money rules 1).
 */
export function percentOf(amount: Cents, numerator: number, denominator: number): Cents {
  if (amount < 0) throw new RangeError("percentOf takes a non-negative base");
  if (!Number.isSafeInteger(numerator) || numerator < 0) {
    throw new RangeError(`numerator must be a non-negative integer, got ${String(numerator)}`);
  }
  if (!Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new RangeError(`denominator must be a positive integer, got ${String(denominator)}`);
  }
  const a = BigInt(amount);
  const n = BigInt(numerator);
  const d = BigInt(denominator);
  return cents(Number((2n * a * n + d) / (2n * d)));
}

/**
 * Split an amount into `parts` equal shares. The first (amount mod parts)
 * shares get the extra cent: $32.67 in two is $16.34 + $16.33.
 */
export function divideEvenly(amount: Cents, parts: number): Cents[] {
  if (!Number.isSafeInteger(parts) || parts < 1) {
    throw new RangeError(`parts must be a positive integer, got ${String(parts)}`);
  }
  if (amount < 0) throw new RangeError("divideEvenly takes a non-negative amount");
  const base = Math.floor(amount / parts);
  const extra = amount % parts;
  const out: Cents[] = [];
  for (let i = 0; i < parts; i += 1) out.push(cents(i < extra ? base + 1 : base));
  return out;
}

/**
 * Split an amount in proportion to `weights` (for example each category's
 * exact tax, or each person's hours). Each part starts at the floor of its
 * exact share; the leftover cents go one each to the parts with the largest
 * fractional remainders, and on a tie to the earlier part. The parts always
 * add up to the amount.
 */
export function divideByWeights(amount: Cents, weights: readonly number[]): Cents[] {
  if (weights.length === 0) throw new RangeError("weights must not be empty");
  if (amount < 0) throw new RangeError("divideByWeights takes a non-negative amount");
  for (const w of weights) {
    if (!Number.isSafeInteger(w) || w < 0) {
      throw new RangeError(`weights must be non-negative integers, got ${String(w)}`);
    }
  }
  const total = weights.reduce((sum, w) => sum + BigInt(w), 0n);
  if (total === 0n) throw new RangeError("weights must not all be zero");

  const a = BigInt(amount);
  const floors: bigint[] = [];
  const remainders: bigint[] = [];
  let handedOut = 0n;
  for (const w of weights) {
    const exact = a * BigInt(w);
    const floor = exact / total;
    floors.push(floor);
    remainders.push(exact % total);
    handedOut += floor;
  }
  let leftover = Number(a - handedOut);
  // Largest remainder first; equal remainders keep their order (stable sort), so ties go to the first parts.
  const order = remainders
    .map((r, i) => ({ r, i }))
    .sort((x, y) => (x.r === y.r ? x.i - y.i : x.r > y.r ? -1 : 1));
  for (const { i } of order) {
    if (leftover === 0) break;
    floors[i] = floors[i]! + 1n;
    leftover -= 1;
  }
  return floors.map((f) => cents(Number(f)));
}
