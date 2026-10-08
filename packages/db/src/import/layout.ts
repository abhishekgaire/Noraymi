import { emptyPosLayout, POS_SECTIONS, POS_SLOTS, type PosLayoutSections } from "@west4/shared";
import type { Temporal } from "@west4/shared";
import { PosLayoutRefused, publishPosLayout } from "../pos-layouts.js";
import type { Queryable } from "../tenancy.js";

/**
 * The bar POS grid for an imported menu (M9-04; Staff screens and the bar POS
 * · rule 2): a new version of the bar's layout, published to start at the
 * next business date, with each new bar item in a fixed slot of its section.
 * Buttons already on the grid stay where they are, so a cutover delta never
 * moves one; new items fill the first free slots of their section.
 */
export interface LayoutResult {
  readonly station: "bar";
  readonly version: number | null;
  readonly starts_on: string | null;
  readonly placed: number;
  readonly not_placed: readonly { item: string; why: string }[];
  /** Why no version was published, when none was. */
  readonly skipped: string | null;
}

/** The grid section for an item: the export's, or the one its category's name starts with. */
export function sectionFor(posSection: string | null, category: string): string | null {
  if (posSection) return posSection;
  const name = category.trim().toLowerCase();
  return POS_SECTIONS.find((s) => s !== "favorites" && name.startsWith(s)) ?? null;
}

/** Fills free slots, leaving every placed item where it is. Pure, for the unit tests. */
export function placeItems(
  base: PosLayoutSections,
  items: readonly { id: string; name: string; section: string | null }[],
): { sections: PosLayoutSections; placed: number; notPlaced: { item: string; why: string }[] } {
  const sections = Object.fromEntries(
    POS_SECTIONS.map((s) => [s, [...(base[s] ?? Array(POS_SLOTS).fill(null))]]),
  ) as Record<string, (string | null)[]>;
  const already = new Set(Object.values(sections).flat());
  let placed = 0;
  const notPlaced: { item: string; why: string }[] = [];
  for (const item of items) {
    if (already.has(item.id)) continue;
    if (!item.section) {
      notPlaced.push({ item: item.name, why: "no bar grid section for its category" });
      continue;
    }
    const slots = sections[item.section]!;
    const free = slots.indexOf(null);
    if (free < 0) {
      notPlaced.push({ item: item.name, why: `the ${item.section} section is full` });
      continue;
    }
    slots[free] = item.id;
    already.add(item.id);
    placed += 1;
  }
  return { sections: sections as PosLayoutSections, placed, notPlaced };
}

export async function publishBarLayout(
  c: Queryable,
  venue: { id: string; timeZone: string; cutover: string },
  items: readonly { itemId: string; posSection: string | null; category: string }[],
  now: Temporal.Instant,
): Promise<LayoutResult> {
  const none = (skipped: string | null, notPlaced: LayoutResult["not_placed"] = []) => ({
    station: "bar" as const,
    version: null,
    starts_on: null,
    placed: 0,
    not_placed: notPlaced,
    skipped,
  });
  if (items.length === 0) return none(null);
  const rows = await c.query<{ id: string; name: string; station: string }>(
    "select id, name, station from menu_items where venue_id = $1 and id = any($2::uuid[]) order by sort, name, id",
    [venue.id, items.map((i) => i.itemId)],
  );
  const byId = new Map(items.map((i) => [i.itemId, i]));
  const bar = rows.rows
    .filter((r) => r.station === "bar")
    .map((r) => ({
      id: r.id,
      name: r.name,
      section: sectionFor(byId.get(r.id)!.posSection, byId.get(r.id)!.category),
    }));
  const draft = await c.query(
    "select 1 from pos_layouts where venue_id = $1 and station = 'bar' and status = 'draft'",
    [venue.id],
  );
  if ((draft.rowCount ?? 0) > 0)
    return none(
      "a draft bar layout is open in Admin → Bar POS: publish it, then place the new items",
    );
  const latest = await c.query<{ sections: PosLayoutSections }>(
    `select sections from pos_layouts where venue_id = $1 and station = 'bar' and status = 'published'
      order by version desc limit 1`,
    [venue.id],
  );
  const { sections, placed, notPlaced } = placeItems(
    latest.rows[0]?.sections ?? emptyPosLayout(),
    bar,
  );
  if (placed === 0) return none(null, notPlaced);
  await c.query("savepoint import_layout");
  const draftId = (
    await c.query<{ id: string }>(
      `insert into pos_layouts (venue_id, station, status, sections) values ($1, 'bar', 'draft', $2) returning id`,
      [venue.id, JSON.stringify(sections)],
    )
  ).rows[0]!.id;
  try {
    const r = await publishPosLayout(c, venue.id, draftId, {
      userId: null,
      now,
      timeZone: venue.timeZone,
      dayCutover: venue.cutover,
    });
    await c.query("release savepoint import_layout");
    return {
      station: "bar",
      version: r.version,
      starts_on: r.starts_on,
      placed,
      not_placed: notPlaced,
      skipped: null,
    };
  } catch (e) {
    if (!(e instanceof PosLayoutRefused)) throw e;
    // Leave no half-made draft behind: the layout simply isn't published.
    await c.query("rollback to savepoint import_layout");
    return none(e.message, notPlaced);
  }
}
