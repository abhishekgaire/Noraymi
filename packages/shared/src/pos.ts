import { z } from "zod";

/**
 * Bar POS layouts (M6-01; Staff screens and the bar POS · rule 2, Admin →
 * Bar POS: Layout; Data model · pos_layouts): ten sections in fixed places,
 * each 25 slots holding a menu item or nothing, so a button never moves.
 */
export const POS_SECTIONS = [
  "favorites",
  "beer",
  "soju",
  "cocktails",
  "shots",
  "spirits",
  "wine",
  "soft",
  "bottles",
  "buckets",
] as const;
export type PosSection = (typeof POS_SECTIONS)[number];
export const POS_SLOTS = 25;

const slots = z.array(z.string().uuid().nullable()).length(POS_SLOTS);
export const posLayoutSectionsSchema = z
  .object(
    Object.fromEntries(POS_SECTIONS.map((s) => [s, slots])) as Record<PosSection, typeof slots>,
  )
  .strict();
export type PosLayoutSections = z.infer<typeof posLayoutSectionsSchema>;

/** A layout with every slot empty. */
export const emptyPosLayout = (): PosLayoutSections =>
  Object.fromEntries(
    POS_SECTIONS.map((s) => [s, Array<string | null>(POS_SLOTS).fill(null)]),
  ) as PosLayoutSections;

/**
 * An item added to a section takes the first empty slot and nothing else
 * moves. null when the section is full or already has the item.
 */
export function addToSection(
  slotsIn: readonly (string | null)[],
  itemId: string,
): (string | null)[] | null {
  if (slotsIn.includes(itemId)) return null;
  const free = slotsIn.indexOf(null);
  if (free < 0) return null;
  const out = [...slotsIn];
  out[free] = itemId;
  return out;
}
