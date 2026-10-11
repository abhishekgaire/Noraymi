import { z } from "zod";

/**
 * Bar POS layouts (M6-01; Staff screens and the bar POS · rule 2, Admin →
 * Bar POS: Layout; Data model · pos_layouts): ten sections in fixed places,
 * each pages of 25 slots holding a menu item or nothing, so a button never
 * moves. A section holds one page, and grows a page at a time up to four
 * (K-12: 44 spirits fit, and the bar POS shows More for the next page).
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
/** Slots on one page of a section. */
export const POS_SLOTS = 25;
/** Pages a section may have (K-12). */
export const POS_PAGES_MAX = 4;

const slots = z
  .array(z.string().uuid().nullable())
  .min(POS_SLOTS)
  .max(POS_SLOTS * POS_PAGES_MAX)
  .refine((x) => x.length % POS_SLOTS === 0, "whole pages of 25 slots");
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
 * moves; a full section grows a page (K-12). null when every page is full or
 * the section already has the item.
 */
export function addToSection(
  slotsIn: readonly (string | null)[],
  itemId: string,
): (string | null)[] | null {
  if (slotsIn.includes(itemId)) return null;
  const out = [...slotsIn];
  if (!out.includes(null)) {
    if (out.length >= POS_SLOTS * POS_PAGES_MAX) return null;
    out.push(...Array<string | null>(POS_SLOTS).fill(null));
  }
  out[out.indexOf(null)] = itemId;
  return out;
}

/** A section's pages of 25 slots (K-12): the bar POS shows one at a time, with More. */
export function sectionPages<T>(slotsIn: readonly T[]): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < slotsIn.length; i += POS_SLOTS) pages.push(slotsIn.slice(i, i + POS_SLOTS));
  return pages.length > 0 ? pages : [[]];
}

/**
 * A section without its trailing empty pages (K-12), keeping the first: what Admin → Bar POS
 * saves after a button comes off the last page.
 */
export function trimSection(slotsIn: readonly (string | null)[]): (string | null)[] {
  let end = slotsIn.length;
  while (end > POS_SLOTS && slotsIn.slice(end - POS_SLOTS, end).every((x) => x === null))
    end -= POS_SLOTS;
  return slotsIn.slice(0, end);
}
