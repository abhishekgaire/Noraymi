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

/** What a walk-in check-in takes (D112). */
export const walkInTakes = ["deposit", "cardOnTab", "cardBehindBar", "nothing"] as const;
export type WalkInTakes = (typeof walkInTakes)[number];
/** The setting's value, with the default ("deposit") when it was never set. */
export const walkInTakesOf = (
  rule: { walkIn?: WalkInTakes | undefined } | null | undefined,
): WalkInTakes => rule?.walkIn ?? "deposit";

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
    /**
     * What a walk-in check-in takes (D112; Admin → Deposits & cancelling): "deposit" (the default
     * when it's missing, West 4: today's step 5), "cardOnTab" (the guest taps a card on the reader
     * and it's saved on the room's check, nothing charged), "cardBehindBar" (D116: staff keep the
     * guest's physical card and type its name and last 4 on the check, no reader, nothing charged;
     * Sing Sing) or "nothing". Online bookings keep their own deposit above.
     */
    walkIn: z.enum(walkInTakes).optional(),
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
  /** A cash discount off the listed (card) price, 0 to 10% (D105): 0 is no discount until set. */
  z
    .object({
      mode: z.literal("discount"),
      pct: z.number().nonnegative().max(10),
      /**
       * With the Kitchen module (O-09; spec 17 · Step details 7): whether food prices already
       * include the card fee. False means food prices are cash prices, which the discount never
       * applies to. Missing reads true.
       */
      foodIncludesFee: z.boolean().optional(),
    })
    .strict(),
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
    // M7-15: Export for QuickBooks: each named account's name in the venue's chart, and where the nightly file goes.
    accounting: z
      .object({
        accounts: z.record(z.string(), z.string().min(1).max(100)).optional(),
        emailTo: z.array(z.string().email()).max(5).optional(),
      })
      .strict()
      .optional(),
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
  .object({
    openingHoldCents: cents,
    flagOverCents: cents,
    cutOffAt: time,
    /**
     * "Open a tab without a card" (P-03; D131), inverted: false lets New tab open a named tab with no
     * card, closed in cash, on the outside card machine or a reader. Absent reads as true (a card first),
     * so a venue saved before it existed keeps card-first tabs.
     */
    cardRequired: z.boolean().optional(),
  })
  .strict();

/** Whether New tab needs a card: true unless the venue turned on "Open a tab without a card". */
export const tabCardRequired = (tabs: { cardRequired?: boolean | undefined } | null | undefined) =>
  tabs?.cardRequired !== false;

export const posSchema = z
  .object({
    layouts: z.record(z.string(), z.number().int().nonnegative()),
    reasonOnly: z.object({ eachCents: cents, perShiftCents: cents }).strict(),
    idleLockMin: z.number().nonnegative(),
    wipeLockSec: z.number().nonnegative(),
    barTabTip: z.enum(["reader", "slip"]),
    /**
     * "Print tickets for drinks rung at the bar" (M6-29; D99): whether Send on a bar tab or a quick
     * sale prints a bar ticket. Room orders always print. Off by default, and absent reads as off,
     * so a venue saved before it existed stays off.
     */
    printBarDrinkTickets: z.boolean().optional(),
    /**
     * "We run our own orders" (U-11; D133): the bar carries its own room orders, so a Ready card on
     * Bar orders has Delivered and no "ready for a runner" push goes to every phone. It changes only
     * which buttons show: Accept is still the sale and Delivered still charges nothing. Off by
     * default, and absent reads as off, so a venue saved before it existed keeps its runners.
     */
    selfRunOrders: z.boolean().optional(),
    /**
     * "Take cash quick sales while offline" (U-16; D133): in queue mode the bar computer also takes a
     * cash quick sale, opens the drawer and replays the sale once on reconnect. Off by default, and
     * absent reads as off, so the drawer stays locked offline (spec 09) until the owner turns it on.
     */
    offlineCashSales: z.boolean().optional(),
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
    /**
     * Refunds over this amount alert the owner (spec 02 · On the record; M8-19; D104). Only the owner
     * sets it, in Admin → Payments, up to $10,000.00; while it's absent every refund alerts.
     */
    refundAlertOverCents: cents.max(1_000_000).optional(),
  })
  .strict();

export const orderingSchema = z.object({ hostLockDefault: z.boolean() }).strict();

export const roomsSchema = z
  .object({
    cleaningMin: z.number().int().nonnegative(),
    cleaningEnds: z.enum(["staff", "timer"]),
    cleaningFlagMin: z.number().int().nonnegative(),
    stayOnWhenFree: z.boolean(),
    /**
     * The mic power trial's one room (M8-23; spec 11 · Mic power trial): its
     * mic outlet turns off between sessions. Absent or null: the trial is off,
     * as it stays until West 4 approves in writing and Playbox answers.
     */
    micPowerTrialRoomId: z.string().uuid().nullable().optional(),
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

export const alertsSchema = z
  .object({
    roomEndingMin: z.number().int().nonnegative(),
    /**
     * Sound when a room's time is up (P-05): the bar computer plays a sound once when a room's tile
     * turns amber and once when it turns red. Absent reads as on (`roomSoundOn`).
     */
    roomSound: z.boolean().optional(),
    /** Its volume, 0 to 100; absent reads as 50 (`roomSoundVolume`). */
    roomSoundVolume: z.number().int().min(0).max(100).optional(),
  })
  .strict();

/** P-05: the room sound is on unless the venue switched it off. */
export function roomSoundOn(a: { roomSound?: boolean | undefined } | null | undefined): boolean {
  return a?.roomSound !== false;
}

/** P-05: the room sound's volume, 0 to 100 (50 until the venue sets it). */
export function roomSoundVolume(
  a: { roomSoundVolume?: number | undefined } | null | undefined,
): number {
  return a?.roomSoundVolume ?? 50;
}

const e164 = z.string().regex(/^\+[1-9]\d{6,14}$/, "an E.164 phone number");
/**
 * The number guests call, and the Twilio number texts come from. The text number is null until our
 * team makes the venue's texting number (O-03): a venue set up in the wizard has none yet.
 */
export const phoneSchema = z.object({ callNumber: e164, textNumber: e164.nullable() }).strict();

/** One of the venue's on-call responders (D115): a membership and the hours they answer, venue time. */
const onCallSchema = z
  .object({
    membershipId: z.string().uuid(),
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    to: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  })
  .strict();

/**
 * Texting (D124; spec 11 · Texting switch): the venue-wide switch and the switches for the texts
 * that have no template. Every field is on by default; emails have no switch, and STOP and HELP
 * replies are always on while a number is connected (the carriers' rule).
 */
export const textingSchema = z
  .object({
    on: z.boolean(),
    staffCodes: z.boolean(),
    orderWaiting: z.boolean(),
    singerCode: z.boolean(),
    staffReplies: z.boolean(),
  })
  .strict();

/**
 * How approvals are decided (D124; spec 02 · Approvals), the owner's choice: on the manager's own
 * phone (the default, as before), by a manager's PIN at the register, or no approval at all (role
 * permissions only, every request still recorded).
 */
export const approvalModes = ["phone", "pin", "none"] as const;
export type ApprovalMode = (typeof approvalModes)[number];
export const approvalsSchema = z.object({ mode: z.enum(approvalModes) }).strict();
export const APPROVALS_DEFAULTS: z.infer<typeof approvalsSchema> = { mode: "phone" };

/**
 * The order of the staff app's side menu (P-13; spec 03 · Menu order), the venue's choice in
 * Admin → Features: the entries' ids, first to last. Lock isn't one of them, it stays last. An
 * entry the list leaves out (one added to the app later) keeps its place after the listed ones, in
 * the app's own order; an empty list is the app's own order. Each role still sees only what it may
 * open: the order never shows an entry, it only places the ones the person has.
 */
export const staffMenuIds = [
  "tonight",
  "barPos",
  "barOrders",
  "songQueue",
  "calendar",
  "messages",
  "tips",
  "clock",
  "reports",
  "closeNight",
  "incidents",
  "admin",
] as const;
export type StaffMenuId = (typeof staffMenuIds)[number];
export const menuOrderSchema = z
  .object({
    order: z
      .array(z.enum(staffMenuIds))
      .max(staffMenuIds.length)
      .refine((ids) => new Set(ids).size === ids.length, "each menu entry appears once"),
  })
  .strict();
export const MENU_ORDER_DEFAULTS: z.infer<typeof menuOrderSchema> = { order: [] };

/**
 * Entries in the venue's order: the listed ids first, as listed, then the rest in their own order,
 * and anything not in `staffMenuIds` (Lock) last, where it was.
 */
export function inMenuOrder<T extends { readonly id: string }>(
  entries: readonly T[],
  order: readonly string[] | null | undefined,
): T[] {
  const rank = new Map((order ?? []).map((id, i) => [id, i] as const));
  const movable = (id: string) => (staffMenuIds as readonly string[]).includes(id);
  const placed = (e: T, i: number) =>
    !movable(e.id) ? 2e6 + i : rank.has(e.id) ? rank.get(e.id)! : 1e6 + i;
  return entries
    .map((e, i) => [e, placed(e, i)] as const)
    .sort((a, b) => a[1] - b[1])
    .map(([e]) => e);
}

/**
 * Ask for the PIN again (P-10; spec 02 · PINs): the actions on which staff in a PIN or badge session
 * type their own PIN again before the action runs, checked on the server. The owner's choice, in
 * Admin → Features → Choices. The default keeps what was there before: only no-sale asks.
 */
export const pinAgainActions = [
  "no_sale",
  "void",
  "comp",
  "discount",
  "refund",
  "reprint_receipt",
  "open_tab",
  "change_tip",
] as const;
export type PinAgainAction = (typeof pinAgainActions)[number];
export const pinAgainSchema = z
  .object({
    actions: z
      .array(z.enum(pinAgainActions))
      .max(pinAgainActions.length)
      .refine((a) => new Set(a).size === a.length, "each action once"),
  })
  .strict();
export const PIN_AGAIN_DEFAULTS: z.infer<typeof pinAgainSchema> = { actions: ["no_sale"] };

/** The texts with a switch in `texting` beside the venue-wide one. */
export type TextingKind = "staffCodes" | "orderWaiting" | "singerCode" | "staffReplies";

/** The `texting` key until a venue saves one: everything on, today's behaviour. */
export const TEXTING_DEFAULTS: z.infer<typeof textingSchema> = {
  on: true,
  staffCodes: true,
  orderWaiting: true,
  singerCode: true,
  staffReplies: true,
};

/**
 * The venue's own contacts, the owner's alone (D115; spec 03 · contacts, spec 17 steps 1 and 9):
 * up to 3 booking inbox addresses, the first and second on-call responders, the breach contact and
 * a backup. Empty until the owner names them, never guessed.
 */
export const contactsSchema = z
  .object({
    bookingEmails: z.array(z.string().trim().toLowerCase().email().max(254)).max(3),
    onCall: z.object({ first: onCallSchema.nullable(), second: onCallSchema.nullable() }).strict(),
    breach: z
      .object({ primary: z.string().uuid().nullable(), backup: z.string().uuid().nullable() })
      .strict(),
  })
  .strict();
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
    /**
     * The venue's age policy (D108): absent or null, 21 and over all night (West 4); a wall-clock
     * time, all ages until then and 21 and over after ("20:00" at Sing Sing, per its website). It
     * words the website, the booking pages and the board's alert at the switch; the alcohol rules
     * (an ID check per guest, on the server) never change with it.
     */
    allAgesUntil: time.nullable().optional(),
  })
  .strict();
export const languagesSchema = z.object({ staff: z.array(z.enum(["en", "es"])).min(1) }).strict();

/** One public form's daily limits: how many uses a business date allows per phone number, IP address and device. */
export const formLimitsSchema = z
  .object({
    perPhone: z.number().int().min(1).max(1000),
    perIp: z.number().int().min(1).max(1000),
    perDevice: z.number().int().min(1).max(1000),
  })
  .strict();
/**
 * The public forms' daily limits (M2-27, D109; Security 8), set by an owner or a manager in
 * Admin → Spam protection. A form left out reads its default (PUBLIC_FORM_DEFAULTS). The
 * server-checked CAPTCHA (Cloudflare Turnstile) has no settings: it is always on.
 */
export const publicFormsSchema = z
  .object({
    waitlist: formLimitsSchema.optional(),
    phoneCode: formLimitsSchema.optional(),
    /** Online booking (M5-05): IP address and device at the hold, the phone number at Details. */
    booking: formLimitsSchema.optional(),
    /** Private-party enquiries (M5-05). */
    enquiry: formLimitsSchema.optional(),
  })
  .strict();

const noticeText = z.string().trim().min(1).max(1000);
/**
 * Kitchen & food (spec 16 · The Kitchen module; K-01). `allergyNotice` is the notice on every menu,
 * in both languages, and the module stays off while it's null: its words are the lawyer's, never
 * ours. `lastOrder` is the kitchen's last order time on the wall clock; null means food follows room
 * ordering (an open question). `unsentWarnMin` is how long staff-rung food may sit Not sent.
 */
export const kitchenSchema = z
  .object({
    allergyNotice: z.object({ en: noticeText, es: noticeText }).strict().nullable(),
    lastOrder: time.nullable(),
    /**
     * When the kitchen starts taking orders (O-06; spec 17 · Step details 5), on the wall clock of
     * the business date. Absent or null: the kitchen opens with the venue.
     */
    opensAt: time.nullable().optional(),
    unsentWarnMin: z.number().int().min(1).max(60),
    /**
     * Whether a replayed food order's kitchen ticket prints "AFTER OUTAGE · check with the kitchen
     * before making" (K-03). An open question for the founder; absent reads as on, the cautious default.
     */
    afterOutage: z.boolean().optional(),
  })
  .strict();

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
  kitchen: kitchenSchema,
  publicForms: publicFormsSchema,
  contacts: contactsSchema,
  texting: textingSchema,
  approvals: approvalsSchema,
  menuOrder: menuOrderSchema,
  pinAgain: pinAgainSchema,
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
export type KitchenSettings = z.infer<typeof kitchenSchema>;
export type FormLimits = z.infer<typeof formLimitsSchema>;
export type PublicFormsSettings = z.infer<typeof publicFormsSchema>;
export type MenuOrderSettings = z.infer<typeof menuOrderSchema>;
export type PublicForm = keyof PublicFormsSettings;
export type ContactsSettings = z.infer<typeof contactsSchema>;
export type TextingSettings = z.infer<typeof textingSchema>;
export type ApprovalSettings = z.infer<typeof approvalsSchema>;

/**
 * The daily limits until a venue sets its own (D109), from common practice for public sign-up
 * forms and texted codes: tight per phone number, looser per device, and loosest per IP address,
 * because a venue's guest Wi-Fi and a phone carrier put many guests behind one address.
 */
export const PUBLIC_FORM_DEFAULTS: Record<PublicForm, FormLimits> = {
  waitlist: { perPhone: 3, perIp: 50, perDevice: 5 },
  phoneCode: { perPhone: 5, perIp: 30, perDevice: 10 },
  booking: { perPhone: 5, perIp: 20, perDevice: 10 },
  enquiry: { perPhone: 3, perIp: 10, perDevice: 5 },
};

/** The `kitchen` key until a venue saves one (spec 16): no notice, no last order, 5 minutes. */
export const KITCHEN_DEFAULTS: KitchenSettings = {
  allergyNotice: null,
  lastOrder: null,
  unsentWarnMin: 5,
};

/** The `contacts` key until the owner names anyone: nobody, never guessed (D115). */
export const CONTACTS_EMPTY: ContactsSettings = {
  bookingEmails: [],
  onCall: { first: null, second: null },
  breach: { primary: null, backup: null },
};

/** Keys every venue reads with a default until it saves its own (a venue made before the key existed). */
export const settingsDefaults: Partial<SettingsMap> = {
  kitchen: KITCHEN_DEFAULTS,
  contacts: CONTACTS_EMPTY,
  publicForms: PUBLIC_FORM_DEFAULTS,
  texting: TEXTING_DEFAULTS,
  approvals: APPROVALS_DEFAULTS,
  menuOrder: MENU_ORDER_DEFAULTS,
  pinAgain: PIN_AGAIN_DEFAULTS,
};

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
