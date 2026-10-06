import { cents, divideByWeights, divideEvenly, type Cents } from "@west4/shared";

/**
 * The tip pool (M7-09; Money rules 1 and 9; spec 03 · `pay.pool`, the rule
 * pack's `gratuity`). Each source of a night's ledger (gratuity, card tips,
 * cash tips) is split on its own, by largest remainder, so every source's
 * shares add up to the cent:
 *   hours       by eligible minutes in an eligible duty, after each
 *               occupation's share when the venue sets shares
 *   even        in equal shares among the eligible people who worked
 *   roomServer  each room check's gratuity to its session's server, and the
 *               rest by hours (a session with no server falls to hours)
 * Owners and managers never share (`managersShare: false`), whatever duty
 * they clocked in with, and a Manager-duty shift never counts.
 */
export type PoolMethod = "hours" | "even" | "roomServer";
export type PoolSource = "gratuity" | "cardTip" | "cashTip";

export interface PoolWorker {
  readonly userId: string;
  readonly role: "owner" | "manager" | "bartender" | "front_desk" | "staff";
  readonly duty: "bar" | "front_desk" | "runner" | "manager";
  readonly minutes: number;
  /** Tip eligible as it stood when the business date started. */
  readonly eligible: boolean;
  readonly occupation?: string | null;
}

export interface PoolShare {
  readonly userId: string;
  readonly duty: PoolWorker["duty"];
  readonly minutes: number;
  readonly gratuityCents: Cents;
  readonly cardTipCents: Cents;
  readonly cashTipCents: Cents;
}

export interface LeftOut {
  readonly userId: string;
  readonly reason: "manager" | "not_eligible";
}

export interface PoolInput {
  readonly method: PoolMethod;
  readonly workers: readonly PoolWorker[];
  readonly gratuityCents: number;
  readonly cardTipCents: number;
  readonly cashTipCents: number;
  /** Each occupation's share in percent; empty means one pool across every eligible duty. */
  readonly occupations?: readonly { readonly code: string; readonly sharePct: number }[];
  /** roomServer: each room check's gratuity and its session's server, if any. */
  readonly roomGratuity?: readonly {
    readonly serverUserId: string | null;
    readonly cents: number;
  }[];
}

export interface PoolResult {
  readonly shares: readonly PoolShare[];
  readonly leftOut: readonly LeftOut[];
  /** A source nobody eligible worked to share (it stays with the house until someone does). */
  readonly unshared: {
    readonly gratuityCents: Cents;
    readonly cardTipCents: Cents;
    readonly cashTipCents: Cents;
  };
}

/** Minutes a shift counts: clock-in to clock-out in real minutes (daylight saving included), less breaks. */
export function poolMinutes(startedAtMs: number, endedAtMs: number, breakMinutes: number): number {
  return Math.max(0, Math.floor((endedAtMs - startedAtMs) / 60_000) - breakMinutes);
}

/** Split a possibly negative amount by weights: the size by largest remainder, the sign kept. */
function bySign(amount: number, weights: readonly number[]): number[] {
  const parts = divideByWeights(cents(Math.abs(amount)), weights);
  return parts.map((p) => (amount < 0 ? -p : p));
}

/** Percent shares (such as 62.5) as integer weights. */
const pctWeight = (pct: number) => Math.round(pct * 10_000);

interface Seat {
  readonly userId: string;
  readonly duty: PoolWorker["duty"];
  minutes: number;
  readonly occupation: string | null;
}

export function poolShares(input: PoolInput): PoolResult {
  const leftOut = new Map<string, LeftOut["reason"]>();
  const seats: Seat[] = [];
  for (const w of input.workers) {
    if (w.role === "owner" || w.role === "manager" || w.duty === "manager") {
      if (!leftOut.has(w.userId)) leftOut.set(w.userId, "manager");
      continue;
    }
    if (!w.eligible) {
      if (!leftOut.has(w.userId)) leftOut.set(w.userId, "not_eligible");
      continue;
    }
    if (w.minutes <= 0) continue;
    const seat = seats.find((s) => s.userId === w.userId && s.duty === w.duty);
    if (seat) seat.minutes += w.minutes;
    else
      seats.push({
        userId: w.userId,
        duty: w.duty,
        minutes: w.minutes,
        occupation: w.occupation ?? null,
      });
  }
  // Someone who shares on one shift isn't "left out" for another.
  for (const s of seats) leftOut.delete(s.userId);

  const totals = new Map<string, { gratuity: number; cardTip: number; cashTip: number }>(
    seats.map((s) => [`${s.userId}|${s.duty}`, { gratuity: 0, cardTip: 0, cashTip: 0 }]),
  );
  const add = (seat: Seat, source: PoolSource, amount: number) => {
    const t = totals.get(`${seat.userId}|${seat.duty}`)!;
    t[source === "gratuity" ? "gratuity" : source === "cardTip" ? "cardTip" : "cashTip"] += amount;
  };
  const unshared = { gratuity: 0, cardTip: 0, cashTip: 0 };

  /** By minutes, after each occupation's share when there are shares. */
  const byHours = (source: PoolSource, amount: number) => {
    if (amount === 0) return;
    if (seats.length === 0) {
      unshared[source === "gratuity" ? "gratuity" : source === "cardTip" ? "cardTip" : "cashTip"] +=
        amount;
      return;
    }
    const occ = (input.occupations ?? []).filter((o) => seats.some((s) => s.occupation === o.code));
    const groups: { seats: Seat[]; amount: number }[] =
      occ.length === 0
        ? [{ seats, amount }]
        : (() => {
            const parts = bySign(
              amount,
              occ.map((o) => pctWeight(o.sharePct)),
            );
            const out = occ.map((o, i) => ({
              seats: seats.filter((s) => s.occupation === o.code),
              amount: parts[i]!,
            }));
            // Anyone eligible in no listed occupation shares nothing; an unlisted occupation is the venue's call.
            return out;
          })();
    for (const g of groups) {
      const parts = bySign(
        g.amount,
        g.seats.map((s) => s.minutes),
      );
      g.seats.forEach((s, i) => add(s, source, parts[i]!));
    }
  };

  /** Equal shares among the eligible people (each person once, on their longest duty). */
  const evenly = (source: PoolSource, amount: number) => {
    if (amount === 0) return;
    const people = [...new Set(seats.map((s) => s.userId))];
    if (people.length === 0) {
      unshared[source === "gratuity" ? "gratuity" : source === "cardTip" ? "cardTip" : "cashTip"] +=
        amount;
      return;
    }
    const parts = divideEvenly(cents(Math.abs(amount)), people.length).map((p) =>
      amount < 0 ? -p : p,
    );
    people.forEach((userId, i) => {
      const seat = seats
        .filter((s) => s.userId === userId)
        .sort((a, b) => b.minutes - a.minutes)[0]!;
      add(seat, source, parts[i]!);
    });
  };

  const split = input.method === "even" ? evenly : byHours;
  let gratuity = input.gratuityCents;
  if (input.method === "roomServer")
    for (const r of input.roomGratuity ?? []) {
      const seat = seats
        .filter((s) => s.userId === r.serverUserId)
        .sort((a, b) => b.minutes - a.minutes)[0];
      if (!seat) continue;
      add(seat, "gratuity", r.cents);
      gratuity -= r.cents;
    }
  split("gratuity", gratuity);
  split("cardTip", input.cardTipCents);
  split("cashTip", input.cashTipCents);

  return {
    shares: seats.map((s) => {
      const t = totals.get(`${s.userId}|${s.duty}`)!;
      return {
        userId: s.userId,
        duty: s.duty,
        minutes: s.minutes,
        gratuityCents: cents(t.gratuity),
        cardTipCents: cents(t.cardTip),
        cashTipCents: cents(t.cashTip),
      };
    }),
    leftOut: [...leftOut].map(([userId, reason]) => ({ userId, reason })),
    unshared: {
      gratuityCents: cents(unshared.gratuity),
      cardTipCents: cents(unshared.cardTip),
      cashTipCents: cents(unshared.cashTip),
    },
  };
}
