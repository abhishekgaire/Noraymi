import { divideByWeights, divideEvenly, type Cents } from "@west4/shared";

/**
 * A package's price divided across its lines (K-09; spec 16 · Food in packages,
 * Money rules 1): in proportion to each line's regular price, the leftover cents
 * to the largest remainders and on a tie to the first lines, so the lines add up
 * to the package price exactly and each keeps its own tax category. One unit is
 * one line (a package's "2 beers" is two lines). When every line's regular price
 * is $0.00 there is nothing to go by, and the price is divided evenly (cautious
 * default). How a mixed package is split for tax is open with the accountant.
 */
export function packageLineShares(
  priceCents: Cents,
  units: readonly { readonly regularCents: number }[],
): Cents[] {
  if (units.length === 0) throw new RangeError("a package needs at least one line");
  const weights = units.map((u) => u.regularCents);
  return weights.every((w) => w === 0)
    ? divideEvenly(priceCents, units.length)
    : divideByWeights(priceCents, weights);
}
