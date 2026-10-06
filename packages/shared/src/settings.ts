import { z } from "zod";

/**
 * Venue settings (spec 03 · Settings): one typed key per topic, each a
 * version in the append-only venue_settings table. The shapes are spec 03's,
 * written as zod schemas so a save can be checked; the types are derived
 * from them and match the spec's TypeScript one for one.
 */
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "a time as HH:MM");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD");
const cents = z.number().int().nonnegative();
const day = z.number().int().min(0).max(6);

export const hoursSchema = z
  .object({
    weekly: z.array(z.object({ day, opens: time, closes: time }).strict()),
    lastCall: time.nullable(),
  })
  .strict();

const rateSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("perPerson"), perPersonCents: cents }).strict(),
  z
    .object({
      mode: z.literal("basePlusExtra"),
      baseCents: cents,
      baseGuests: z.number().int().positive(),
      extraCents: cents,
    })
    .strict(),
  z.object({ mode: z.literal("flatBySize"), bySizeCents: z.record(z.string(), cents) }).strict(),
]);

const billingSchema = z
  .object({
    incrementMin: z.union([z.literal(1), z.literal(15), z.literal(30), z.literal(60)]),
    rounding: z.enum(["up", "nearest", "down"]),
  })
  .strict();

export const pricesSchema = z
  .object({
    rate: rateSchema,
    billing: billingSchema,
    minGuests: z
      .object({ weeknight: z.number().int().positive(), friSat: z.number().int().positive() })
      .strict(),
    firstHourMinimum: z.boolean(),
    bands: z.array(
      z
        .object({
          name: z.string().min(1),
          days: z.array(day),
          fromMin: z.number().int().min(0).max(1799),
          toMin: z.number().int().min(0).max(1800),
          rate: rateSchema,
          billing: billingSchema,
        })
        .strict(),
    ),
    vip: z
      .object({
        roomIds: z.array(z.string()),
        hourlyCents: cents,
        fromGuests: z.number().int().positive(),
      })
      .strict()
      .nullable(),
    minSpend: z.array(
      z
        .object({ tier: z.string(), days: z.array(day), band: z.string().nullable(), cents })
        .strict(),
    ),
    booking: z
      .object({
        minHours: z.number().positive(),
        maxHours: z.number().positive(),
        maxGuests: z.number().int().positive(),
        startSlots: z.array(time),
      })
      .strict(),
    damageFeeCents: cents,
  })
  .strict();

export const depositSchema = z
  .object({
    on: z.boolean(),
    mode: z.enum(["firstHour", "perPerson", "flat", "percent", "cardHold"]),
    value: z.number().nonnegative(),
    refundHours: z.number().nonnegative(),
    late: z.enum(["keep", "half", "refund"]),
    noShow: z.enum(["keep", "firstHour", "nothing"]),
    graceMin: z.number().int().nonnegative(),
    bigParty: z
      .object({
        fromGuests: z.number().int().positive(),
        deposit: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("flat"), cents }).strict(),
          z.object({ kind: z.literal("pct"), pct: z.number().positive().max(100) }).strict(),
        ]),
        refundHours: z.number().nonnegative(),
        /** A minimum spend for a big party (Money rules 6; M4-27): 0 at West 4. */
        minSpendCents: cents.optional(),
      })
      .strict()
      .nullable(),
  })
  .strict();

const cardFeeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("off") }).strict(),
  z
    .object({
      mode: z.literal("surcharge"),
      pct: z.number().nonnegative(),
      noticeSentOn: isoDate.nullable(),
    })
    .strict(),
  z.object({ mode: z.literal("discount"), pct: z.number().nonnegative() }).strict(),
]);

export const paySchema = z
  .object({
    cardFee: cardFeeSchema,
    gratuity: z
      .object({
        auto: z.enum(["off", "rooms", "parties", "all"]),
        pct: z.number().nonnegative(),
        partyMin: z.number().int().positive().optional(),
      })
      .strict(),
    tipScreen: z
      .object({
        on: z.boolean(),
        pcts: z.tuple([
          z.number().nonnegative(),
          z.number().nonnegative(),
          z.number().nonnegative(),
        ]),
        fixedCents: z.tuple([cents, cents, cents]),
        smartThresholdCents: cents,
      })
      .strict(),
    tipReview: z
      .object({
        overPct: z.number().nonnegative(),
        overCents: cents,
        lateHours: z.number().nonnegative(),
      })
      .strict(),
    pool: z.enum(["hours", "even", "roomServer"]),
    // M7-09: each eligible occupation's share of the pool; empty is one pool split by minutes.
    occupations: z
      .array(
        z
          .object({ code: z.string().min(1).max(40), sharePct: z.number().min(0).max(100) })
          .strict(),
      )
      .max(20)
      .optional(),
    // M7-09: gratuity refunded after its pool closed; the cautious default is the house absorbs it.
    refundedGratuity: z.enum(["house", "nextPool"]).optional(),
    roomHold: z.object({ on: z.boolean(), cents }).strict(),
    payShare: z.object({ on: z.boolean() }).strict(),
  })
  .strict();

export const drawerSchema = z
  .object({
    drawer: z.enum(["house", "perPerson"]),
    startingBankCents: cents,
    noteOverCents: cents,
    secondCounter: z.enum(["never", "whenOff", "always"]),
    paidOutApprovalCents: cents,
    perPerson: z
      .object({ who: z.enum(["bartenders", "bartendersAndServers"]), countLater: z.boolean() })
      .strict(),
  })
  .strict();

export const tabsSchema = z
  .object({ openingHoldCents: cents, flagOverCents: cents, cutOffAt: time })
  .strict();

export const posSchema = z
  .object({
    layouts: z.record(z.string(), z.number().int().nonnegative()),
    reasonOnly: z.object({ eachCents: cents, perShiftCents: cents }).strict(),
    idleLockMin: z.number().nonnegative(),
    wipeLockSec: z.number().nonnegative(),
    barTabTip: z.enum(["reader", "slip"]),
    orderAging: z
      .object({
        phonesSec: z.number().nonnegative(),
        amberSec: z.number().nonnegative(),
        pinkSec: z.number().nonnegative(),
        callSec: z.number().nonnegative(),
      })
      .strict(),
    chime: z.boolean(),
    muteSec: z.number().nonnegative(),
  })
  .strict();

export const orderingSchema = z.object({ hostLockDefault: z.boolean() }).strict();

export const roomsSchema = z
  .object({
    cleaningMin: z.number().int().nonnegative(),
    cleaningEnds: z.enum(["staff", "timer"]),
    cleaningFlagMin: z.number().int().nonnegative(),
    stayOnWhenFree: z.boolean(),
  })
  .strict();

export const barModeSchema = z
  .object({
    songPriceCents: cents.nullable(),
    drinkCredit: z.boolean(),
    freeNights: z.array(day),
    songsPerRound: z.number().int().positive(),
    alerts: z
      .object({ beforeYou: z.number().int().nonnegative(), upNextText: z.boolean() })
      .strict(),
    upNextCount: z.number().int().nonnegative(),
    /** "Buy a song, get a drink": a free drink with a song, which the promotion checks refuse until the lawyer answers. */
    freeDrinkWithSong: z.boolean().optional(),
  })
  .strict();

export const alertsSchema = z.object({ roomEndingMin: z.number().int().nonnegative() }).strict();

const e164 = z.string().regex(/^\+[1-9]\d{6,14}$/, "an E.164 phone number");
export const phoneSchema = z.object({ callNumber: e164, textNumber: e164 }).strict();
export const websiteSchema = z
  .object({ priceWording: z.enum(["plusTaxAndGratuity", "allIn"]) })
  .strict();
export const messagesSchema = z
  .object({ reminderAt: time.nullable(), offerExpiringMin: z.number().int().nonnegative() })
  .strict();
export const safetySchema = z
  .object({
    occupancyLimit: z.number().int().positive().nullable(),
    warnAtPct: z.number().min(0).max(100),
  })
  .strict();
export const languagesSchema = z.object({ staff: z.array(z.enum(["en", "es"])).min(1) }).strict();

export const settingsSchemas = {
  hours: hoursSchema,
  prices: pricesSchema,
  deposit: depositSchema,
  pay: paySchema,
  drawer: drawerSchema,
  tabs: tabsSchema,
  pos: posSchema,
  ordering: orderingSchema,
  rooms: roomsSchema,
  barMode: barModeSchema,
  alerts: alertsSchema,
  phone: phoneSchema,
  website: websiteSchema,
  messages: messagesSchema,
  safety: safetySchema,
  languages: languagesSchema,
} as const;

export type SettingsKey = keyof typeof settingsSchemas;
export const settingsKeys = Object.keys(settingsSchemas) as SettingsKey[];

export type Hours = z.infer<typeof hoursSchema>;
export type Rate = z.infer<typeof rateSchema>;
export type Billing = z.infer<typeof billingSchema>;
export type PriceSettings = z.infer<typeof pricesSchema>;
export type DepositRule = z.infer<typeof depositSchema>;
export type CardFee = z.infer<typeof cardFeeSchema>;
export type PaySettings = z.infer<typeof paySchema>;
export type CashSettings = z.infer<typeof drawerSchema>;
export type TabSettings = z.infer<typeof tabsSchema>;
export type PosSettings = z.infer<typeof posSchema>;
export type OrderingSettings = z.infer<typeof orderingSchema>;
export type RoomSettings = z.infer<typeof roomsSchema>;
export type BarModeSettings = z.infer<typeof barModeSchema>;
export type AlertSettings = z.infer<typeof alertsSchema>;
export type PhoneSettings = z.infer<typeof phoneSchema>;
export type WebsiteSettings = z.infer<typeof websiteSchema>;
export type MessageSettings = z.infer<typeof messagesSchema>;
export type SafetySettings = z.infer<typeof safetySchema>;
export type LanguageSettings = z.infer<typeof languagesSchema>;

export type SettingsValue<K extends SettingsKey> = z.infer<(typeof settingsSchemas)[K]>;
export type SettingsMap = { [K in SettingsKey]: SettingsValue<K> };

export function isSettingsKey(key: string): key is SettingsKey {
  return Object.prototype.hasOwnProperty.call(settingsSchemas, key);
}

/** Validate a value for a key. Returns the parsed value or the reasons it was refused. */
export function parseSetting<K extends SettingsKey>(
  key: K,
  value: unknown,
): { ok: true; value: SettingsValue<K> } | { ok: false; reasons: string[] } {
  const result = settingsSchemas[key].safeParse(value);
  if (result.success) return { ok: true, value: result.data as SettingsValue<K> };
  return {
    ok: false,
    reasons: result.error.issues.map(
      (i) => `${key}${i.path.length ? "." + i.path.join(".") : ""}: ${i.message}`,
    ),
  };
}

/**
 * Which changes wait for the next business date (spec 03 · When a change
 * starts): the drawer model, the tip-pool method and the bar POS layouts.
 * Everything else is live at once.
 */
export function startsNextBusinessDate(
  key: SettingsKey,
  previous: unknown,
  next: unknown,
): boolean {
  if (previous === undefined || previous === null) return false;
  if (key === "drawer") return JSON.stringify(previous) !== JSON.stringify(next);
  if (key === "pay") return (previous as PaySettings).pool !== (next as PaySettings).pool;
  if (key === "pos")
    return (
      JSON.stringify((previous as PosSettings).layouts) !==
      JSON.stringify((next as PosSettings).layouts)
    );
  return false;
}

/**
 * `value` with the parts that wait for the next business date taken from
 * `from` (M6-25): the whole drawer model, the pay key's tip-pool method and
 * the pos key's layouts. A save splits on it, so a change saved together with
 * a layout is still live at once, and a save tonight carries a layout that's
 * already waiting for tomorrow instead of replacing it.
 */
export function withLaterPart(key: SettingsKey, value: unknown, from: unknown): unknown {
  if (key === "drawer") return from;
  if (key === "pay") return { ...(value as PaySettings), pool: (from as PaySettings).pool };
  if (key === "pos") return { ...(value as PosSettings), layouts: (from as PosSettings).layouts };
  return value;
}
