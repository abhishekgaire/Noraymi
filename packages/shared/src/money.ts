/**
 * Money is an integer number of cents, never a float (spec conventions).
 * The helpers that produce and divide Cents arrive with ticket M1-04.
 */
export type Cents = number & { readonly __brand: "cents" };

export interface Money {
  readonly amount: Cents;
  readonly currency: "usd";
}
