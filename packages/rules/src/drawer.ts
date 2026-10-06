/**
 * Drawer counts (M7-05; Money rules 15; spec 08 · Drawer). What a drawer
 * session should hold comes only from its moves: the opening bank, plus cash
 * in (sales with their cash tips, drops), minus cash out (refunds, paid-outs,
 * tip-outs). A no-sale opens the drawer and moves nothing. Counts are blind:
 * the person counting sends only what they counted, and only the answer
 * shows what it should have been and the over or short.
 */
export type DrawerMoveKind = "sale" | "refund" | "paid_out" | "drop" | "no_sale" | "tip_out";

export interface DrawerMove {
  readonly kind: DrawerMoveKind;
  /** Always the size of the move (never negative); the kind says which way it goes. */
  readonly amountCents: number;
}

/** +1 into the drawer, −1 out of it, 0 for a no-sale. */
export function moveSign(kind: DrawerMoveKind): 1 | -1 | 0 {
  if (kind === "sale" || kind === "drop") return 1;
  if (kind === "no_sale") return 0;
  return -1;
}

export interface DrawerTotals {
  readonly openingCents: number;
  /** Sales, cash tips included. */
  readonly cashTakenCents: number;
  readonly dropsCents: number;
  readonly refundsCents: number;
  readonly paidOutsCents: number;
  readonly tipOutsCents: number;
  readonly noSales: number;
  readonly expectedCents: number;
}

export function drawerTotals(openingCents: number, moves: readonly DrawerMove[]): DrawerTotals {
  const sum = (kind: DrawerMoveKind) =>
    moves.filter((m) => m.kind === kind).reduce((s, m) => s + m.amountCents, 0);
  return {
    openingCents,
    cashTakenCents: sum("sale"),
    dropsCents: sum("drop"),
    refundsCents: sum("refund"),
    paidOutsCents: sum("paid_out"),
    tipOutsCents: sum("tip_out"),
    noSales: moves.filter((m) => m.kind === "no_sale").length,
    expectedCents: moves.reduce((s, m) => s + moveSign(m.kind) * m.amountCents, openingCents),
  };
}

export type SecondCounter = "never" | "whenOff" | "always";

export interface CountCheck {
  readonly overShortCents: number;
  /** The difference is over the venue's limit, so the count needs a note. */
  readonly needsNote: boolean;
  /** A second person counts too, on their own sign-in. */
  readonly needsWitness: boolean;
}

/**
 * What a count needs before it saves. Over or short beyond `noteOverCents`
 * needs a note; `secondCounter` "always" asks for a second person every
 * time, "whenOff" only when the count is off by more than that limit.
 */
export function checkCount(input: {
  readonly countedCents: number;
  readonly expectedCents: number;
  readonly noteOverCents: number;
  readonly secondCounter: SecondCounter;
}): CountCheck {
  const overShortCents = input.countedCents - input.expectedCents;
  const off = Math.abs(overShortCents) > input.noteOverCents;
  return {
    overShortCents,
    needsNote: off,
    needsWitness: input.secondCounter === "always" || (input.secondCounter === "whenOff" && off),
  };
}
