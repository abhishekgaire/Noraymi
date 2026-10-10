/**
 * The Not sent reminder (K-05; Kitchen and food · Not sent reminder): food staff rang that hasn't
 * gone to the kitchen. N counts the unsent food items (quantities, not lines); the reminder shows
 * once any of it has waited `kitchen.unsentWarnMin` minutes on the venue's clock. Before a tab or
 * check is closed or paid the warning shows for any unsent food, however long it has waited.
 */
export interface UnsentFoodItem {
  readonly qty: number;
  /** When it was rung (an ISO instant); null when unknown, which never starts the reminder. */
  readonly rungAt: string | null;
}

export interface UnsentFood {
  readonly count: number;
  /** The reminder is due: some food has waited at least `warnMin` minutes. */
  readonly warn: boolean;
}

export function unsentFood(
  items: readonly UnsentFoodItem[],
  nowMs: number,
  warnMin: number,
): UnsentFood {
  const live = items.filter((i) => i.qty > 0);
  const count = live.reduce((n, i) => n + i.qty, 0);
  const warn = live.some((i) => {
    if (!i.rungAt) return false;
    const at = Date.parse(i.rungAt);
    return Number.isFinite(at) && nowMs - at >= warnMin * 60_000;
  });
  return { count, warn };
}
