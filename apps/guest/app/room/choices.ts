/**
 * A line's choices on the room page (K-12; spec 16 · Meals, combos and sauces): which groups are
 * open for a size and the picks so far, whether the picks are complete, and the line's price for
 * the basket. A preview only: the server prices the order with packages/rules (menu-choices.ts),
 * and the basket's price comes from that same function.
 */
import { priceChoices } from "@west4/rules";

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

/**
 * The line's unit price with its picks and components, by the one shared rule the server charges
 * with (packages/rules priceChoices). While the picks aren't complete yet, the preview prices what
 * is picked so far by the same rule, without the least-picks check.
 */
export function unitWithPicks(
  priceCents: number,
  groups: readonly ChoiceGroup[],
  variantId: string,
  picked: readonly string[],
): number {
  const r = priceChoices({
    variantId,
    priceCents,
    chosen: keepOpen(groups, variantId, picked),
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      required: false,
      minChoices: 0,
      maxChoices: most(g),
      includedChoices: g.included_choices ?? null,
      extraChoiceCents: g.extra_choice_cents ?? 0,
      variantIds: g.variant_ids ?? null,
      whenOptionId: g.when_option_id ?? null,
      options: g.options.map((o) => ({
        id: o.id,
        name: o.name,
        priceDeltaCents: o.price_delta_cents,
        component: o.component ? { regularCents: o.component.price_cents } : null,
      })),
    })),
  });
  if (!r.ok) return priceCents;
  return r.parentUnitCents + r.choices.reduce((s, c) => s + (c.component ? c.lineCents : 0), 0);
}
