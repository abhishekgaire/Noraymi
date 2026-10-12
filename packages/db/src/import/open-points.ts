import type { Prepared } from "./prepare.js";

/**
 * The menu's open points (O-10; spec 17 · Step details 8): what a menu file can't settle on its
 * own, listed on the item for the owner to answer in Admin → Menu. Nothing is decided for them:
 *   - extra_price: a choice group whose picks are all included, so no extra pick is offered
 *     until the owner sets the most picks and the extra pick's price (an extra sauce);
 *   - included_choice: a group whose choices are other menu lines given with the item (a combo's
 *     side or drink): which ones it includes, and whether a pricier one costs extra;
 *   - draft: a Draft variant, offered until the owner turns it off where it isn't on tap (D105);
 *   - pour: a Shot variant with no description, where the pour size is the owner's words (D105).
 */
export type OpenPointKind = "extra_price" | "included_choice" | "draft" | "pour";

export interface OpenPoint {
  readonly kind: OpenPointKind;
  /** The item's name as the file gives it. */
  readonly item: string;
  /** The choice group's name, for extra_price and included_choice. */
  readonly group: string | null;
}

export function menuOpenPoints(p: Pick<Prepared, "menu" | "modifiers">): OpenPoint[] {
  const nameOf = new Map<string, string>();
  for (const m of p.menu) if (!nameOf.has(m.itemRef)) nameOf.set(m.itemRef, m.name);
  const out: OpenPoint[] = [];
  const seen = new Set<string>();
  const add = (kind: OpenPointKind, item: string, group: string | null) => {
    const key = `${kind}|${item}|${group ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, item, group });
  };
  for (const x of p.modifiers) {
    const item = nameOf.get(x.itemRef) ?? x.itemRef;
    if (x.includedChoices !== null && x.maxChoices <= x.includedChoices)
      add("extra_price", item, x.group);
    if (x.componentRef !== null) add("included_choice", item, x.group);
  }
  for (const m of p.menu) {
    const variant = m.variant.toLowerCase();
    if (variant === "draft") add("draft", m.name, null);
    if (variant === "shot" && !m.description) add("pour", m.name, null);
  }
  return out;
}
