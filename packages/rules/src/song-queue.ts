/**
 * The bar-mode song queue (M6-18; Song systems and texts · Bar mode: Rotation
 * and Credits). Pure rules: where a new song goes in the round-robin, the
 * order songs are sung in, what a staff move swaps, and how many drink
 * credits a check line earns.
 */
export type SongStatus = "queued" | "singing" | "sung" | "skipped" | "removed";

export interface QueuedSong {
  readonly id: string;
  readonly singerId: string;
  readonly round: number;
  readonly position: number;
  readonly status: SongStatus;
}

/** A skipped or removed song gave its turn up, so it doesn't count toward the singer's round. */
const counts = (s: QueuedSong) =>
  s.status === "queued" || s.status === "singing" || s.status === "sung";

const order = (a: QueuedSong, b: QueuedSong) => a.round - b.round || a.position - b.position;

/**
 * The round now: the round of the song being sung, else the first round with a song still to sing,
 * else the last round anyone sang in, else round 1.
 */
export function currentRound(songs: readonly QueuedSong[]): number {
  const singing = songs.find((s) => s.status === "singing");
  if (singing) return singing.round;
  const queued = songs.filter((s) => s.status === "queued").map((s) => s.round);
  if (queued.length > 0) return Math.min(...queued);
  const sung = songs.filter((s) => s.status === "sung").map((s) => s.round);
  return sung.length > 0 ? Math.max(...sung) : 1;
}

/**
 * Where a singer's new song goes: round-robin by singer, at most `songsPerRound` songs per singer in a
 * round. It goes into the first round, from the current one on, where the singer still has room, at
 * the end of that round. A new singer joins at the end of the current round, in join order (the
 * ticket's cautious default; the spec doesn't say).
 */
export function placeNewSong(
  songs: readonly QueuedSong[],
  singerId: string,
  songsPerRound: number,
): { round: number; position: number } {
  if (!Number.isInteger(songsPerRound) || songsPerRound < 1)
    throw new RangeError("songsPerRound must be a whole number of at least 1");
  let round = currentRound(songs);
  const theirs = (r: number) =>
    songs.filter((s) => s.singerId === singerId && s.round === r && counts(s)).length;
  while (theirs(round) >= songsPerRound) round += 1;
  const inRound = songs.filter((s) => s.round === round).map((s) => s.position);
  return { round, position: inRound.length > 0 ? Math.max(...inRound) + 1 : 1 };
}

/** The songs still to sing, in the order they'll be sung. */
export function upNext(songs: readonly QueuedSong[]): readonly QueuedSong[] {
  return songs.filter((s) => s.status === "queued").sort(order);
}

export interface Swap {
  readonly id: string;
  readonly round: number;
  readonly position: number;
}

/**
 * A staff move one place up or down: the song trades its place (round and position) with the queued
 * song next to it. Null when there's nowhere to go (already first or last, or not queued).
 */
export function moveSwap(
  songs: readonly QueuedSong[],
  id: string,
  direction: "up" | "down",
): readonly [Swap, Swap] | null {
  const line = upNext(songs);
  const i = line.findIndex((s) => s.id === id);
  if (i < 0) return null;
  const j = direction === "up" ? i - 1 : i + 1;
  const me = line[i]!;
  const other = line[j];
  if (!other) return null;
  return [
    { id: me.id, round: other.round, position: other.position },
    { id: other.id, round: me.round, position: me.position },
  ];
}

export interface CreditLine {
  readonly id: number;
  readonly kind: string;
  readonly qty: number;
  readonly taxCategory: string | null;
  readonly reversesId: number | null;
}

/**
 * "Buy a drink, get a song": the credits each drink line earns. One per unit sold (a bucket is one
 * item), less every unit a comp or void took back; food, songs and fees earn none. The spec doesn't
 * say what counts as one drink; this is the ticket's cautious default.
 */
export function drinkCreditUnits(lines: readonly CreditLine[]): ReadonlyMap<number, number> {
  const back = new Map<number, number>();
  for (const l of lines)
    if ((l.kind === "comp" || l.kind === "void") && l.reversesId !== null)
      back.set(l.reversesId, (back.get(l.reversesId) ?? 0) + Math.abs(l.qty));
  const out = new Map<number, number>();
  for (const l of lines) {
    if (l.kind !== "item" || l.taxCategory !== "drink") continue;
    out.set(l.id, Math.max(0, Math.floor(l.qty) - Math.ceil(back.get(l.id) ?? 0)));
  }
  return out;
}

/** What a queued song is flagged with: none when it holds a credit or the venue sells songs. */
export function songFlag(input: {
  readonly holdsCredit: boolean;
  readonly songPriceCents: number | null;
  /** A free night (`barMode.freeNights`): no song price, so no song needs a credit. */
  readonly freeNight?: boolean;
}): "needs_drink_credit" | null {
  return !input.freeNight && !input.holdsCredit && input.songPriceCents === null
    ? "needs_drink_credit"
    : null;
}

export type SongCharge =
  | {
      readonly kind: "charge";
      readonly paidWith: "drink_credit" | "prepaid_credit" | "price";
      /** The song line's amount, in cents ($0.00 on a drink credit). */
      readonly amountCents: number;
      /** Whether a line posts: only on an open tab. */
      readonly postsLine: boolean;
    }
  | { readonly kind: "refused"; readonly reason: "needs_drink_credit" | "needs_tab" };

/**
 * What Started charges (M6-19; Money rules 6, Songs; Payment flows · Songs on a tab). A song is charged when it
 * starts, never when it's queued: a drink credit posts $0.00; a prepaid song credit posts what was paid for it,
 * redeemed from the prepaid value; with no credit, the venue's song price. A singer with no tab spends a credit
 * and no line posts. With no credit and no song price the song needs a drink credit; with a price, a tab.
 */
export function songCharge(input: {
  readonly credit: { readonly source: "drink" | "prepaid"; readonly valueCents: number } | null;
  readonly songPriceCents: number | null;
  readonly hasTab: boolean;
  /**
   * A free night (`barMode.freeNights`, M6-26): the song costs nothing and spends no credit; a $0.00
   * line posts on a tab, and a singer with no tab needs none.
   */
  readonly freeNight?: boolean;
}): SongCharge {
  const { credit, songPriceCents, hasTab } = input;
  if (input.freeNight)
    return { kind: "charge", paidWith: "price", amountCents: 0, postsLine: hasTab };
  if (credit)
    return {
      kind: "charge",
      paidWith: credit.source === "prepaid" ? "prepaid_credit" : "drink_credit",
      amountCents: credit.source === "prepaid" ? credit.valueCents : 0,
      postsLine: hasTab,
    };
  if (songPriceCents === null) return { kind: "refused", reason: "needs_drink_credit" };
  if (!hasTab) return { kind: "refused", reason: "needs_tab" };
  return { kind: "charge", paidWith: "price", amountCents: songPriceCents, postsLine: true };
}

/** One prepaid song credit's value: what its purchase paid, shared over the credits it gave (whole cents). */
export function prepaidCreditValue(issuedCents: number, credits: number): number {
  return credits > 0 ? Math.floor(issuedCents / credits) : 0;
}
