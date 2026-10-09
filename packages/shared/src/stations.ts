/**
 * Stations (spec 16 · Stations; K-02). Every menu item has one station, and an option or a
 * variant goes with its item, so it prints on its item's ticket. A basket or a round with lines
 * for both stations becomes one order per station, placed together: the bar's first ("Drinks"),
 * then the kitchen's ("Food"), each keeping its lines in the order they were sent.
 */
export const STATIONS = ["bar", "kitchen"] as const;
export type Station = (typeof STATIONS)[number];

export function isStation(value: unknown): value is Station {
  return value === "bar" || value === "kitchen";
}

export interface StationPart<T> {
  readonly station: Station;
  readonly lines: T[];
}

/** One part per station that has lines, bar first; a line's options travel inside the line. */
export function splitByStation<T extends { readonly station: string }>(
  lines: readonly T[],
): StationPart<T>[] {
  const parts: StationPart<T>[] = [];
  for (const station of STATIONS) {
    const mine = lines.filter((l) => l.station === station);
    if (mine.length > 0) parts.push({ station, lines: mine });
  }
  const unknown = lines.find((l) => !isStation(l.station));
  if (unknown) throw new Error(`no station "${unknown.station}"`);
  return parts;
}

/**
 * Food categories (D100; K-02): the menu's categories whose items are station `kitchen`, in the
 * menu's order. The bar POS's food row and the guest menu's food sections follow this list.
 */
export function foodCategories<
  C extends { readonly items: readonly { readonly station: string }[] },
>(categories: readonly C[]): C[] {
  return categories.filter((c) => c.items.some((i) => i.station === "kitchen"));
}

/**
 * Moving one category up or down among `ordered` (already in menu order): the sorts to save so the
 * new order holds, numbered from the first one's sort in tens. Only the rows that change are listed.
 */
export function moveCategory(
  ordered: readonly { readonly id: string; readonly sort: number }[],
  id: string,
  direction: "up" | "down",
): { id: string; sort: number }[] {
  const from = ordered.findIndex((c) => c.id === id);
  const to = direction === "up" ? from - 1 : from + 1;
  if (from < 0 || to < 0 || to >= ordered.length) return [];
  const next = [...ordered];
  [next[from], next[to]] = [next[to]!, next[from]!];
  const base = Math.min(...ordered.map((c) => c.sort));
  return next
    .map((c, n) => ({ id: c.id, sort: base + n * 10 }))
    .filter((c) => ordered.find((o) => o.id === c.id)!.sort !== c.sort);
}
