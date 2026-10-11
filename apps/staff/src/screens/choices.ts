import { priceChoices } from "@west4/rules";

/**
 * A line's choices on the staff screens (K-12; spec 16 · Meals, combos and sauces): which groups
 * are open for the chosen size and the picks so far, the picks that still stand when a group
 * closes, what's missing, and the price the server will charge (priceChoices, the same rule the
 * order uses), components included.
 */
export interface ChoiceOptionLike {
  readonly id: string;
  readonly name: string;
  readonly out_tonight: boolean;
  readonly price_delta_cents?: number;
  readonly is_default?: boolean;
  readonly component?: { readonly name: string; readonly price_cents: number } | null;
}
export interface ChoiceGroupLike {
  readonly id: string;
  readonly name: string;
  readonly required?: boolean;
  readonly min_choices?: number;
  readonly max_choices?: number;
  readonly included_choices?: number | null;
  readonly extra_choice_cents?: number;
  readonly variant_ids?: readonly string[] | null;
  readonly when_option_id?: string | null;
  readonly options: readonly ChoiceOptionLike[];
}

/** A group the line must pick from (when it's open). */
export const needsPick = (g: ChoiceGroupLike) => g.required === true || (g.min_choices ?? 0) > 0;

/** Whether a group is open: for this size, and its opening choice picked (if it has one). */
export const isOpen = (g: ChoiceGroupLike, variantId: string, picked: readonly string[]) =>
  (g.variant_ids == null || g.variant_ids.includes(variantId)) &&
  (g.when_option_id == null || picked.includes(g.when_option_id));

/** The picks that still stand: a closed group's picks drop, and with them the groups they opened. */
export function prunePicks(
  groups: readonly ChoiceGroupLike[],
  variantId: string,
  picked: readonly string[],
): string[] {
  let now = [...picked];
  for (;;) {
    const next = now.filter((id) => {
      const g = groups.find((x) => x.options.some((o) => o.id === id));
      return g !== undefined && isOpen(g, variantId, now);
    });
    if (next.length === now.length) return next;
    now = next;
  }
}

/** The open groups, in menu order. */
export const openGroups = <G extends ChoiceGroupLike>(
  groups: readonly G[],
  variantId: string,
  picked: readonly string[],
): G[] => groups.filter((g) => isOpen(g, variantId, picked));

/** A tap on a choice: one-pick groups swap, others add up to their max; the result is pruned. */
export function togglePick(
  groups: readonly ChoiceGroupLike[],
  variantId: string,
  picked: readonly string[],
  group: ChoiceGroupLike,
  id: string,
): string[] {
  const max = group.max_choices ?? 1;
  const inGroup = picked.filter((p) => group.options.some((o) => o.id === p));
  let next: string[];
  if (picked.includes(id)) next = picked.filter((p) => p !== id);
  else if (max <= 1) next = [...picked.filter((p) => !inGroup.includes(p)), id];
  else if (inGroup.length >= max) return [...picked];
  else next = [...picked, id];
  const kept = prunePicks(groups, variantId, next);
  // A group the tap opened starts with its default choices ("Make it a meal" picks the fries).
  const opened = groups.filter((g) => !isOpen(g, variantId, picked) && isOpen(g, variantId, kept));
  return [
    ...kept,
    ...opened.flatMap((g) =>
      g.options
        .filter((o) => o.is_default && !o.out_tonight && !kept.includes(o.id))
        .map((o) => o.id),
    ),
  ];
}

/** The first open group that still needs a pick, or undefined. */
export function missingGroup<G extends ChoiceGroupLike>(
  groups: readonly G[],
  variantId: string,
  picked: readonly string[],
): G | undefined {
  return openGroups(groups, variantId, picked).find(
    (g) =>
      g.options.filter((o) => picked.includes(o.id)).length <
      Math.max(g.min_choices ?? 0, g.required ? 1 : 0),
  );
}

/** The defaults a new line starts with: each open group's default choices. */
export function defaultPicks(groups: readonly ChoiceGroupLike[], variantId: string): string[] {
  const picks = groups
    .filter((g) => g.variant_ids == null || g.variant_ids.includes(variantId))
    .flatMap((g) => g.options.filter((o) => o.is_default && !o.out_tonight).map((o) => o.id));
  return prunePicks(groups, variantId, picks);
}

/**
 * The unit price of the line with its components, as the order will charge it. Falls back to the
 * variant plus each pick's price change while the picks aren't complete yet.
 */
export function unitWithChoices(
  groups: readonly ChoiceGroupLike[],
  variant: { readonly id: string; readonly price_cents: number },
  picked: readonly string[],
): number {
  const r = priceChoices({
    variantId: variant.id,
    priceCents: variant.price_cents,
    chosen: picked,
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      required: g.required === true,
      minChoices: g.min_choices ?? 0,
      maxChoices: g.max_choices ?? 1,
      includedChoices: g.included_choices ?? null,
      extraChoiceCents: g.extra_choice_cents ?? 0,
      variantIds: g.variant_ids ?? null,
      whenOptionId: g.when_option_id ?? null,
      options: g.options.map((o) => ({
        id: o.id,
        name: o.name,
        priceDeltaCents: o.price_delta_cents ?? 0,
        component: o.component ? { regularCents: o.component.price_cents } : null,
      })),
    })),
  });
  if (r.ok)
    return r.parentUnitCents + r.choices.reduce((s, c) => s + (c.component ? c.lineCents : 0), 0);
  return (
    variant.price_cents +
    groups
      .flatMap((g) => g.options)
      .filter((o) => picked.includes(o.id))
      .reduce((s, o) => s + (o.price_delta_cents ?? 0), 0)
  );
}

/** Whether a line needs the choices sheet rather than one-tap ringing or inline selects. */
export const needsSheet = (groups: readonly ChoiceGroupLike[]) =>
  groups.some(
    (g) =>
      g.when_option_id != null ||
      g.variant_ids != null ||
      (g.max_choices ?? 1) > 1 ||
      g.options.some((o) => o.component),
  );

/** A choice's label: a component shows the menu item it is when its name differs. */
export const choiceLabel = (o: ChoiceOptionLike) =>
  o.component && o.component.name !== o.name ? `${o.name} (${o.component.name})` : o.name;
