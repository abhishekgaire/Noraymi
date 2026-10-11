/**
 * A line's choices on the room page (K-12; spec 16 · Meals, combos and sauces): which groups are
 * open for a size and the picks so far, whether the picks are complete, and the line's price for
 * the basket. A preview only: the server prices the order with packages/rules (menu-choices.ts),
 * and this follows the same rule (included picks counted in menu order, each extra at the
 * group's price, components at their own price; a meal's price stays in the total either way).
 */
export interface ChoiceOption {
  readonly id: string;
  readonly name: string;
  readonly price_delta_cents: number;
  readonly is_default: boolean;
  readonly out_tonight: boolean;
  readonly component?: { readonly price_cents: number } | null;
}
export interface ChoiceGroup {
  readonly id: string;
  readonly name: string;
  readonly required: boolean;
  readonly min_choices?: number;
  readonly max_choices?: number;
  readonly included_choices?: number | null;
  readonly extra_choice_cents?: number;
  readonly variant_ids?: readonly string[] | null;
  readonly when_option_id?: string | null;
  readonly options: readonly ChoiceOption[];
}

/** A group applies to this size (null: every size). */
export const forSize = (g: ChoiceGroup, variantId: string) =>
  !g.variant_ids || g.variant_ids.includes(variantId);

/** The groups open for a size and the picks so far, in menu order. */
export const openGroups = (
  groups: readonly ChoiceGroup[],
  variantId: string,
  picked: readonly string[],
) =>
  groups.filter(
    (g) => forSize(g, variantId) && (!g.when_option_id || picked.includes(g.when_option_id)),
  );

/** The least and most picks a group takes. */
export const least = (g: ChoiceGroup) => Math.max(g.min_choices ?? 0, g.required ? 1 : 0);
export const most = (g: ChoiceGroup) => Math.max(g.max_choices ?? 1, 1);

/** Picks that stay once groups close (a meal's side goes when the meal is unpicked). */
export function keepOpen(
  groups: readonly ChoiceGroup[],
  variantId: string,
  picked: readonly string[],
): string[] {
  let now = [...picked];
  for (;;) {
    const open = new Set(
      openGroups(groups, variantId, now).flatMap((g) => g.options.map((o) => o.id)),
    );
    const next = now.filter((id) => open.has(id));
    if (next.length === now.length) return next;
    now = next;
  }
}

/** Every open group has enough picks, and none too many. */
export const complete = (
  groups: readonly ChoiceGroup[],
  variantId: string,
  picked: readonly string[],
) =>
  openGroups(groups, variantId, picked).every((g) => {
    const n = g.options.filter((o) => picked.includes(o.id)).length;
    return n >= least(g) && n <= most(g);
  });

/** The default picks for a size: each open group's defaults, then any group they open. */
export function defaultPicks(groups: readonly ChoiceGroup[], variantId: string): string[] {
  let picked: string[] = [];
  for (;;) {
    const next = openGroups(groups, variantId, picked).flatMap((g) =>
      g.options.filter((o) => o.is_default && !o.out_tonight).map((o) => o.id),
    );
    const all = [...new Set([...picked, ...next])];
    if (all.length === picked.length) return picked;
    picked = all;
  }
}

/** The line's unit price with its picks: the size, each pick's change, extras past the included. */
export function unitWithPicks(
  priceCents: number,
  groups: readonly ChoiceGroup[],
  variantId: string,
  picked: readonly string[],
): number {
  let cents = priceCents;
  for (const g of openGroups(groups, variantId, picked)) {
    let n = 0;
    for (const o of g.options) {
      if (!picked.includes(o.id)) continue;
      const extra =
        g.included_choices != null && n >= g.included_choices ? (g.extra_choice_cents ?? 0) : 0;
      cents += o.price_delta_cents + extra;
      n += 1;
    }
  }
  return cents;
}
