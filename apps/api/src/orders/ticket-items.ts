/**
 * A ticket's lines for one station (K-12; Kitchen and food · Meals, combos and sauces): a
 * component prints under the line it came with, as "+ Fries", when both are on this ticket; a
 * component whose line is on the other station's ticket (a meal's soda at the bar) prints as its
 * own line, "with Classic Cheese".
 */
export function ticketItems<
  T extends {
    readonly id: string;
    readonly qty: number;
    readonly name_snapshot: string;
    readonly options: readonly { readonly name: string }[];
    readonly parent_item_id: string | null;
    readonly component: { readonly parent: string } | null;
  },
>(items: readonly T[]): { item: T; options: string[] }[] {
  const here = new Set(items.map((i) => i.id));
  return items
    .filter((i) => !(i.parent_item_id && here.has(i.parent_item_id)))
    .map((i) => ({
      item: i,
      options: [
        ...i.options.map((o) => o.name),
        ...items
          .filter((x) => x.parent_item_id === i.id)
          .map((x) =>
            x.qty === i.qty ? `+ ${x.name_snapshot}` : `+ ${x.qty} x ${x.name_snapshot}`,
          ),
        ...(i.component && !(i.parent_item_id && here.has(i.parent_item_id))
          ? [`with ${i.component.parent}`]
          : []),
      ],
    }));
}
