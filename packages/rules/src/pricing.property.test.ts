import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Temporal, cents, type Cents, type PriceSettings } from "@west4/shared";
import { bandAt, rateAt, segmentsFor, type SessionEvent } from "./bands.js";
import { hourlyCentsFor } from "./rates.js";
import { roomTime, roundToStep } from "./room-time.js";
import { businessDate } from "./time.js";
import { WEST4_PRICES, WEST4_TIME } from "./west4-fixtures.js";

/**
 * M2-03 property tests (spec 13 · Tests). Every generated session is billed
 * two ways: by segments (the real code) and by a reference that walks the
 * session minute by minute, written separately below. They must agree to the
 * cent; the bill is rounded once, never drops as minutes grow, applies the
 * first-hour minimum once, and with a step of 1 equals the per-minute sum.
 * Segments tile the session, and on the two daylight-saving nights their
 * minutes equal the real elapsed time.
 */
const room = { id: "room_1", sizeTier: "m" };
const venue = WEST4_TIME;

/** Minute by minute: the rate in force at each minute, summed exactly, rounded once at the end. */
function reference(
  start: Temporal.Instant,
  minutes: number,
  partySize: number,
  events: readonly SessionEvent[],
  prices: PriceSettings,
  stepped: boolean,
): { cents: number; billedMinutes: number } {
  let party = partySize;
  let paused = false;
  let weighted = 0;
  let billed = 0;
  let firstRate: number | null = null;
  let lastRate = 0;
  for (let m = 0; m < minutes; m++) {
    const at = start.add({ minutes: m });
    for (const e of events) {
      if (Temporal.Instant.compare(e.at, at) === 0) {
        if (e.partySize !== undefined) party = e.partySize;
        if (e.paused !== undefined) paused = e.paused;
      }
    }
    if (paused) continue;
    const bd = businessDate(at, venue.timeZone, venue.dayCutover);
    const min =
      bd.businessDate.dayOfWeek === 5 || bd.businessDate.dayOfWeek === 6
        ? prices.minGuests.friSat
        : prices.minGuests.weeknight;
    const guests = Math.max(party, min);
    const band = bandAt(prices, bd.businessDate, bd.minutesFromMidnight);
    const vip =
      prices.vip && prices.vip.roomIds.includes(room.id) && party >= prices.vip.fromGuests;
    const hourly = vip
      ? prices.vip!.hourlyCents
      : hourlyCentsFor(band.rate, guests, room).hourlyCents;
    if (firstRate === null) firstRate = hourly;
    lastRate = hourly;
    weighted += hourly;
    billed += 1;
  }
  if (prices.firstHourMinimum && firstRate !== null && billed < 60) {
    weighted += firstRate * (60 - billed);
    billed = 60;
  }
  if (stepped && billed > 60 && lastRate > 0) {
    const endBand = bandAt(
      prices,
      businessDate(start.add({ minutes: minutes - 1 }), venue.timeZone, venue.dayCutover)
        .businessDate,
      businessDate(start.add({ minutes: minutes - 1 }), venue.timeZone, venue.dayCutover)
        .minutesFromMidnight,
    );
    const after = billed - 60;
    const rounded = roundToStep(after, endBand.billing);
    weighted += lastRate * (rounded - after);
    billed += rounded - after;
  }
  return { cents: Math.floor((weighted + 30) / 60), billedMinutes: billed };
}

/** The bill the real code gives, with the step of the band the session ends in. */
function bill(
  start: Temporal.Instant,
  minutes: number,
  partySize: number,
  events: readonly SessionEvent[],
  prices: PriceSettings,
  stepped: boolean,
) {
  const end = start.add({ minutes });
  const segments = segmentsFor({ start, end, partySize, room, events }, prices, venue);
  const last = segments.at(-1);
  const step =
    stepped && last ? { incrementMin: last.incrementMin, rounding: last.rounding } : undefined;
  return {
    segments,
    bill: roomTime(segments, { firstHourMinimum: prices.firstHourMinimum, step }),
  };
}

const money = (max: number) => fc.integer({ min: 100, max }).map((n) => cents(n) as number);
const rateArb: fc.Arbitrary<PriceSettings["rate"]> = fc.oneof(
  fc.record({ mode: fc.constant("perPerson" as const), perPersonCents: money(5000) }),
  fc.record({
    mode: fc.constant("basePlusExtra" as const),
    baseCents: money(20000),
    baseGuests: fc.integer({ min: 1, max: 6 }),
    extraCents: money(3000),
  }),
  fc.record({
    mode: fc.constant("flatBySize" as const),
    bySizeCents: fc.record({ m: money(30000) }),
  }),
);
const billingArb: fc.Arbitrary<PriceSettings["billing"]> = fc.record({
  incrementMin: fc.constantFrom(1 as const, 15 as const, 30 as const, 60 as const),
  rounding: fc.constantFrom("up" as const, "nearest" as const, "down" as const),
});
/** Up to three bands a day, each a run of whole minutes inside the business date, non-overlapping. */
const bandsArb: fc.Arbitrary<PriceSettings["bands"]> = fc
  .array(
    fc.record({
      days: fc.uniqueArray(fc.integer({ min: 0, max: 6 }), { minLength: 1, maxLength: 7 }),
      from: fc.integer({ min: 360, max: 1799 }),
      length: fc.integer({ min: 1, max: 600 }),
      rate: rateArb,
      billing: billingArb,
    }),
    { maxLength: 3 },
  )
  .map((raw) =>
    raw.map((b, i) => ({
      name: `band-${i}`,
      days: b.days,
      fromMin: b.from,
      toMin: Math.min(1800, b.from + b.length),
      rate: b.rate,
      billing: b.billing,
    })),
  );
const pricesArb: fc.Arbitrary<PriceSettings> = fc
  .record({ rate: rateArb, billing: billingArb, bands: bandsArb, firstHourMinimum: fc.boolean() })
  .map((p) => ({ ...WEST4_PRICES, ...p, vip: null }));

const starts = [
  "2026-09-25T20:00:00-04:00", // an ordinary Friday
  "2026-09-23T18:30:00-04:00", // a Wednesday
  "2026-10-31T22:00:00-04:00", // the fall-back night, Nov 1, 2026
  "2027-03-13T22:00:00-05:00", // the spring-forward night, Mar 14, 2027
  "2026-09-26T04:00:00-04:00", // across the 6:00 AM cutover
];
const sessionArb = fc.record({
  start: fc
    .constantFrom(...starts)
    .chain((s) =>
      fc
        .integer({ min: 0, max: 240 })
        .map((offset) => Temporal.Instant.from(s).add({ minutes: offset })),
    ),
  minutes: fc.integer({ min: 1, max: 480 }),
  partySize: fc.integer({ min: 1, max: 25 }),
  changes: fc.array(
    fc.record({
      after: fc.integer({ min: 1, max: 479 }),
      partySize: fc.option(fc.integer({ min: 1, max: 25 }), { nil: undefined }),
      paused: fc.option(fc.boolean(), { nil: undefined }),
    }),
    { maxLength: 3 },
  ),
});
const eventsOf = (
  start: Temporal.Instant,
  changes: { after: number; partySize?: number | undefined; paused?: boolean | undefined }[],
): SessionEvent[] =>
  changes.map((c) => ({
    at: start.add({ minutes: c.after }),
    ...(c.partySize !== undefined ? { partySize: c.partySize } : {}),
    ...(c.paused !== undefined ? { paused: c.paused } : {}),
  }));

describe("pricing properties", () => {
  it("room time by segments equals the minute-by-minute reference, in every rate mode, step and rounding", () => {
    fc.assert(
      fc.property(pricesArb, sessionArb, fc.boolean(), (prices, s, stepped) => {
        const events = eventsOf(s.start, s.changes);
        const real = bill(s.start, s.minutes, s.partySize, events, prices, stepped);
        const ref = reference(s.start, s.minutes, s.partySize, events, prices, stepped);
        expect(real.bill.cents).toBe(ref.cents);
        expect(real.bill.billedMinutes).toBe(ref.billedMinutes);
      }),
      { numRuns: 300 },
    );
  });

  it("segments tile the session with no gap and no overlap, and their minutes are the real elapsed time on the daylight-saving nights", () => {
    fc.assert(
      fc.property(pricesArb, sessionArb, (prices, s) => {
        const events = eventsOf(s.start, s.changes);
        const { segments } = bill(s.start, s.minutes, s.partySize, events, prices, false);
        expect(segments[0]?.startedAt.toString()).toBe(s.start.toString());
        expect(segments.at(-1)?.endedAt.toString()).toBe(
          s.start.add({ minutes: s.minutes }).toString(),
        );
        for (let i = 1; i < segments.length; i++)
          expect(segments[i]!.startedAt.toString()).toBe(segments[i - 1]!.endedAt.toString());
        const total = segments.reduce((sum, seg) => sum + seg.minutes, 0);
        expect(total).toBe(s.minutes);
        for (const seg of segments)
          expect(seg.minutes).toBe(
            (seg.endedAt.epochMilliseconds - seg.startedAt.epochMilliseconds) / 60_000,
          );
      }),
      { numRuns: 300 },
    );
  });

  it("the bill never drops as minutes grow, applies the first-hour minimum once, and with a step of 1 equals the per-minute sum", () => {
    fc.assert(
      fc.property(pricesArb, sessionArb, fc.integer({ min: 1, max: 60 }), (prices, s, more) => {
        const events = eventsOf(s.start, s.changes);
        const withStep = { ...prices, billing: prices.billing };
        const shorter = bill(s.start, s.minutes, s.partySize, events, withStep, true);
        const longer = bill(s.start, s.minutes + more, s.partySize, events, withStep, true);
        // The spec rounds by the step of the band the session ends in, so a longer session that
        // ends in a band with a smaller step can bill less (flagged in M2-03). With the same step
        // at both ends, more minutes never cost less.
        const endA = shorter.segments.at(-1)!;
        const endB = longer.segments.at(-1)!;
        // Inside the first hour the top-up is priced at the first segment's rate, so a cheaper
        // later minute can replace a dearer top-up minute (flagged too). And a step's rounding moves
        // minutes at the last segment's rate, so with the rate changing it can take off more than
        // those minutes billed (the third corner, flagged in M2-03). At one rate past the hour, never.
        const rates = new Set(longer.segments.filter((x) => !x.paused).map((x) => x.hourlyCents));
        if (
          endA.incrementMin === endB.incrementMin &&
          endA.rounding === endB.rounding &&
          shorter.bill.elapsedMinutes >= 60 &&
          rates.size === 1
        )
          expect(longer.bill.cents).toBeGreaterThanOrEqual(shorter.bill.cents);
        // The first hour's minimum: never more than one hour billed for less than an hour of time.
        if (prices.firstHourMinimum && shorter.bill.elapsedMinutes < 60)
          expect(shorter.bill.billedMinutes).toBe(60);
        if (!prices.firstHourMinimum && shorter.bill.elapsedMinutes <= 60)
          expect(shorter.bill.billedMinutes).toBe(shorter.bill.elapsedMinutes);
        // A step of 1 everywhere: the per-minute sum, rounded once.
        const byMinute = {
          ...prices,
          billing: { incrementMin: 1 as const, rounding: "nearest" as const },
          bands: prices.bands.map((b) => ({
            ...b,
            billing: { incrementMin: 1 as const, rounding: "nearest" as const },
          })),
        };
        const stepOne = bill(s.start, s.minutes, s.partySize, events, byMinute, true);
        const exact = stepOne.segments
          .filter((x) => !x.paused)
          .reduce((sum, x) => sum + x.hourlyCents * x.minutes, 0);
        const elapsed = stepOne.segments
          .filter((x) => !x.paused)
          .reduce((sum, x) => sum + x.minutes, 0);
        const first = stepOne.segments.find((x) => !x.paused);
        const topUp =
          prices.firstHourMinimum && first && elapsed < 60 ? first.hourlyCents * (60 - elapsed) : 0;
        expect(stepOne.bill.cents).toBe(Math.floor((exact + topUp + 30) / 60));
      }),
      { numRuns: 200 },
    );
  });

  it("the VIP flat rate applies by party size at the instant, in a VIP room only", () => {
    const at = Temporal.Instant.from("2026-09-25T22:00:00-04:00");
    expect(rateAt(at, 20, { id: "room_vip" }, WEST4_PRICES, venue).hourlyCents).toBe(
      25000 as Cents,
    );
    expect(rateAt(at, 20, { id: "room_1" }, WEST4_PRICES, venue).hourlyCents).toBe(20000 as Cents);
  });
});
