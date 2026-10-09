import { createHash, randomUUID } from "node:crypto";
import { LOCAL_DEV_AUTH_KEY, encryptSecret, parseAuthSecretKey, recoveryCodeHash } from "./auth.js";
import { pinVerifier } from "./pins.js";
import { badgeUidHash } from "./badges.js";
import { demoBadgeUid } from "./sun.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  SEED_NOW,
  Temporal,
  actions,
  defaultPermissions,
  isModuleId,
  moduleDef,
  parseSetting,
  roles,
  settingsKeys,
  type Action,
  type ModuleId,
  type Role,
  type SettingsKey,
  siteContentSchema,
  type DepositRule,
  type PaySettings,
} from "@west4/shared";
import { depositPolicyText, type Duty } from "@west4/rules";
import { publishPolicy } from "./policies.js";
import { WEST4_POS_LAYOUT } from "./seed-pos-layout.js";
import type { DeviceKind } from "./devices.js";
import { reasonOnlyUsed } from "./reports/reason-only.js";
import { recordPunch } from "./shifts.js";

/**
 * The demo seed loader (docs/demo-seed.md · Loading the seed; M1-17). It
 * reads seed/west4-friday.json and writes the M1 part: the venue, its
 * settings, the permission table, the team and the 28 devices, then sets
 * the shared simulated clock to Fri Sep 25, 2026, 10:41 PM. Each later
 * milestone adds its own part of the file here.
 *
 * Every slug in the file (west4, maya, dev_router) becomes the same UUID on
 * every load, and the slug is kept in seed_ids, so a test can find a row by
 * name and two loads give the same ids. A load wipes what it owns first, so
 * every end-to-end test starts from the same Friday night.
 */

// ---------------------------------------------------------------- the file

/** The parts of seed/west4-friday.json this ticket reads. */
interface SeedTab {
  readonly id: string;
  readonly check: string;
  readonly name: string;
  readonly label?: string | null;
  readonly state: string;
  readonly card_brand: string;
  readonly card_last4: string;
  readonly hold_cents: number;
  readonly opened_at: string;
  readonly owner: string;
  readonly cut_off_at?: string;
  readonly cut_off_by?: string;
}

export interface SeedFile {
  readonly meta: { readonly now: string; readonly business_date: string };
  /** The guest site's published content (M5-01). */
  readonly site?: { readonly published_version: number; readonly content: unknown };
  readonly venue: {
    readonly id: string;
    readonly name: string;
    readonly address: string;
    readonly postal_code?: string;
    readonly legal_name?: string;
    readonly phone_e164: string;
    readonly time_zone: string;
    readonly slug: string;
    readonly rule_pack_id: string;
    readonly modules_on: readonly string[];
    readonly modules_off: readonly string[];
  };
  readonly settings: SeedSettings;
  readonly role_permissions: readonly SeedPermissionRow[];
  readonly team: readonly SeedPerson[];
  readonly badges: readonly SeedBadge[];
  readonly devices: readonly SeedDevice[];
  readonly rooms: readonly SeedRoom[];
  readonly guests: readonly SeedGuest[];
  readonly bookings: readonly SeedBooking[];
  readonly sessions: readonly SeedSession[];
  readonly checks: readonly SeedCheck[];
  readonly texts: readonly SeedText[];
  readonly menu: SeedMenu;
  readonly orders: readonly SeedOrder[];
  readonly order_drafts: readonly SeedDraft[];
  readonly approvals: readonly SeedApproval[];
  readonly reason_only_used_tonight: readonly { readonly person: string; readonly cents: number }[];
  readonly bar_tabs: readonly SeedTab[];
  readonly tip_slips: readonly SeedTipSlip[];
  readonly drawers: readonly SeedDrawer[];
  readonly singers: readonly SeedSinger[];
  readonly song_queue: SeedSongQueue;
}

/** A bar-mode singer (M6-18): a confirmed number, a tab once they owe something, and the credits they hold. */
export interface SeedSinger {
  readonly id: string;
  readonly name: string;
  readonly phone_e164: string;
  readonly check: string | null;
  readonly credits: number;
}

/** The night's singer queue (M6-18): round 3, 23 sung, Luis M. singing and six up next. */
export interface SeedSongQueue {
  readonly bar_mode_started_at: string;
  readonly songs_sung_so_far: number;
  readonly round: number;
  readonly now_singing: {
    readonly singer: string;
    readonly title: string;
    readonly artist: string;
    readonly started_by: string;
    readonly started_at: string;
    readonly check: string | null;
  };
  readonly up_next: readonly {
    readonly position: number;
    readonly singer: string;
    readonly title: string;
    readonly artist: string;
  }[];
}

/** A signed paper tip slip waiting in Tips to enter (M6-09): a bar tab awaiting its tip, its photo kept. */
export interface SeedTipSlip {
  readonly id: string;
  readonly name: string;
  readonly card_brand: string;
  readonly card_last4: string;
  readonly tab_total_cents: number;
  readonly signed_at: string;
  readonly photo_saved: boolean;
  readonly tip_entered_cents: number | null;
}

/** A house drawer and its open session (M4-10): $300.00 starting bank, the manager on duty answering for it. */
export interface SeedDrawer {
  readonly id: string;
  readonly name: string;
  readonly kick_port_of: string;
  readonly screen: string;
  readonly session: {
    readonly id: string;
    readonly model: "house" | "per_person";
    readonly state: "open";
    readonly responsible: string;
    readonly opening_cents: number;
    readonly opened_at: string | null;
  };
}

/** An unsent draft (M3-25): a person's drinks on a tab, never part of its check. */
export interface SeedDraft {
  readonly membership: string;
  readonly tab: string;
  readonly lines: readonly { readonly item_id: string; readonly qty: number }[];
}

/** A pending approval (M3-25): a comp or void of one check line, over the reason-only limit. */
export interface SeedApproval {
  readonly id: string;
  readonly line_kind: "comp" | "void";
  readonly target: string;
  readonly tab: string;
  readonly item: string;
  readonly amount_cents: number;
  readonly reason: string;
  readonly made: boolean;
  readonly requested_by: string;
  readonly requested_at: string | null;
  readonly routed_to: string;
  readonly status: "pending";
}

/** A room order (M3-06): ringing ones wait for Accept; accepted ones are on their check already. */
export interface SeedOrder {
  readonly id: string;
  readonly session: string;
  readonly check: string;
  readonly source: "room" | "staff" | "gift" | "offline";
  readonly status: string;
  readonly cancel_reason: string | null;
  readonly items: readonly {
    readonly item_id: string;
    readonly name: string;
    readonly qty: number;
    readonly unit_cents: number;
    readonly alcohol: boolean;
    readonly options?: Readonly<Record<string, string>>;
  }[];
  readonly placed_at: string | null;
  readonly accepted_by?: string | null;
  readonly accepted_at?: string | null;
  readonly ready_at?: string | null;
  readonly delivered_by?: string | null;
  readonly delivered_at?: string | null;
  readonly ticket_printed?: boolean;
}

/** The menu (M3-03): items by section, shared choice groups and what's 86'd tonight. */
export interface SeedMenu {
  readonly count: number;
  readonly out_tonight: readonly string[];
  readonly option_groups: Readonly<
    Record<
      string,
      {
        readonly label: string;
        readonly required: boolean;
        readonly default?: string;
        readonly choices: readonly string[];
        readonly mixers?: readonly (readonly [string, number])[];
      }
    >
  >;
  readonly items: readonly {
    readonly id: string;
    readonly name: string;
    readonly section: string;
    readonly unit_cents: number;
    readonly alcohol: boolean;
    readonly option_group: string | null;
  }[];
}

/** An NTAG 424 DNA badge in the seed: the person it's paired to. Its demo UID is derived from its id (DEMO ONLY). */
export interface SeedBadge {
  readonly id: string;
  readonly person: string;
  readonly type: string;
}

export interface SeedPermissionRow {
  readonly action: string;
  readonly owner: boolean | "limited";
  readonly manager: boolean | "limited";
  readonly bartender: boolean | "limited";
  readonly front_desk: boolean | "limited";
  readonly staff: boolean | "limited";
}

export interface SeedPerson {
  readonly id: string;
  readonly name: string;
  readonly role: Role;
  readonly pin_digits: 4 | 6;
  readonly locale: "en" | "es";
  /** DEMO ONLY (M1-19): a placeholder address the owner or manager signs in with. */
  readonly demo_email?: string;
  /** DEMO ONLY (M1-23): the fix brief's demo PIN, stored as a verifier like a real one; never loaded in production. */
  readonly demo_pin?: string;
  /** DEMO ONLY (M1-19): a fixed authenticator-app secret (base32), loaded only when AUTH_SECRET_KEY is set. */
  readonly demo_totp_secret?: string;
  /** DEMO ONLY (M1-20): fixed recovery codes for the demo owner, stored hashed like real ones. */
  readonly demo_recovery_codes?: readonly string[];
  /** On the clock at "now" (M7-01): the duty and the clock-in, or null when not on shift. */
  readonly shift?: { readonly duty: Duty; readonly clock_in: string } | null;
}

export interface SeedRoom {
  readonly id: string;
  readonly name: string;
  readonly size_tier: string;
  readonly capacity_min: number;
  readonly capacity_max: number;
  readonly is_vip: boolean;
  readonly state: "available" | "in_use" | "wrap_up" | "cleaning" | "out_of_service";
  readonly note?: string;
  readonly board_label?: string;
  readonly fault?: {
    readonly text: string;
    readonly reported_on?: string;
    readonly out_of_service?: boolean;
  };
}

export interface SeedBooking {
  readonly id: string;
  readonly guest: string;
  readonly party_size: number;
  readonly room: string;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly business_date: string;
  readonly deposit_cents: number;
  /** What the deposit was paid with, when the brief names the card (Marcus's Amex ··1005). */
  readonly deposit_card?: { readonly brand: string; readonly last4: string } | null;
  readonly deposit_captured_cents?: number;
  readonly running_late_until?: string | null;
  readonly status: "pending" | "confirmed" | "checked_in" | "no_show" | "cancelled" | "completed";
}

export interface SeedGuest {
  readonly id: string;
  readonly name: string;
  readonly phone_e164?: string | null;
  readonly email?: string | null;
  readonly locale?: "en" | "es";
}

export interface SeedSegment {
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly billable_guests: number;
  readonly rate_kind: "per_person" | "base_plus_extra" | "flat_by_size" | "vip";
  readonly hourly_cents: number;
  readonly paused: boolean;
}

export interface SeedSession {
  readonly id: string;
  readonly room: string;
  readonly booking: string | null;
  /** The party's guest: the booking's, or a walk-in's (Leo M. in Room 5). */
  readonly guest?: string | null;
  /** The room code guests join with; Room 9's is fixed (KX4M7), the rest the loader makes. */
  readonly room_code?: string | null;
  readonly started_at: string;
  readonly booked_end_at: string | null;
  readonly business_date: string;
  readonly check: string | null;
  readonly party_size: number;
  readonly segments: readonly SeedSegment[];
  readonly ids_checked?: { readonly checked: number; readonly of: number } | null;
}

export interface SeedCheckLine {
  readonly id: string;
  readonly kind: string;
  readonly description: string;
  readonly qty: number;
  readonly unit_cents: number;
  readonly amount_cents: number;
  readonly tax_category: string | null;
  readonly comp_of?: string | null;
  readonly by?: string | null;
  readonly reason?: string | null;
  readonly made?: boolean | null;
  readonly added_at?: string | null;
  readonly delivered_at?: string | null;
  /** The order this line was sold from (M3-06): its items' lines, in order. */
  readonly order?: string | null;
}

export interface SeedCheck {
  readonly id: string;
  readonly number: number | null;
  readonly kind: "room" | "bar" | "quick" | "fee";
  readonly business_date: string;
  readonly room_session?: string | null;
  readonly status: string;
  readonly opened_at: string;
  readonly lines?: readonly SeedCheckLine[];
}

export interface SeedText {
  readonly n: number;
  readonly id: string;
  readonly category: "service" | "marketing";
  readonly on: boolean;
}

/**
 * West 4's 14 texts (spec 11), in the seed's wording with named slots where the seed shows one booking's
 * details. Keys follow the spec's list; the two marketing texts stay off until they have their own opt-in.
 */
export const SEED_TEXT_TEMPLATES: Readonly<Record<string, { key: string; body: string }>> = {
  conf: {
    key: "booking_confirmed",
    body: "Booked. Room for {party} at {time}, {date}. A {gratuity} gratuity is added to room tabs. Deposit {deposit} paid, comes off your bill. Free to cancel until {cutoff}: {link}",
  },
  rem: {
    key: "reminder",
    body: "Tonight at {venue}: room for {party} at {time}. {address}. Reply if anything changes.",
  },
  code: {
    key: "room_code",
    // The seed's wording plus the join link spec 11 says this text carries (flagged in M2-11).
    body: "Welcome to {room}. To order drinks from your phone, scan the code on the wall and enter room code {code}. Or open {link}",
  },
  ready: {
    key: "room_ready",
    body: "Your room is ready: {room}. You have 10 minutes to claim it at the front desk.",
  },
  offer: {
    key: "offer_expiring",
    body: "5 minutes left to claim your room at {venue}. After that it goes to the next party in line.",
  },
  wrap: {
    key: "please_wrap_up",
    body: "10 minutes left in {room}. The next party is here, so please start wrapping up. Thank you!",
  },
  ten: {
    key: "booked_time_ending",
    body: "Your booked time in {room} ends at {end}. Nobody's booked after you, so you can stay on by the minute until we close at {close}.",
  },
  rcpt: { key: "receipt", body: "Thanks for singing with us. Your receipt for {amount}: {link}" },
  refund: {
    key: "deposit_refund",
    body: "Your {amount} deposit for {date} is on its way back to your card. It takes 5–10 days to show.",
  },
  paylink: {
    key: "payment_link",
    body: "{venue} is holding the {room} for {party} on {date} at {time}. Agree to the terms and pay the {amount} deposit here: {link}",
  },
  late: { key: "running_late_reply", body: "No problem. We'll hold your room until {until}." },
  upnext: {
    key: "up_next",
    body: "You're up next at the bar. Come to the stage when this song ends.",
  },
  rev: {
    key: "review_ask",
    body: "Hope last night was a good one. Two taps to tell Google: {link}",
  },
  bday: {
    key: "birthday",
    body: "Your birthday's coming up. Book a room this month and the first song's on us.",
  },
};

export interface SeedDevice {
  readonly id: string;
  readonly kind: DeviceKind;
  readonly name: string;
  readonly room?: string;
  readonly owner?: string;
  readonly online?: boolean;
  /** A USB badge reader's computer (M9-07's device check reads the link). */
  readonly host?: string;
  /** A Stripe reader with cellular on (its Stripe side comes from stripe:seed). */
  readonly cellular?: boolean;
  readonly cellular_backup?: boolean;
  readonly on_backup_now?: boolean;
}

/** The seed's settings block, typed loosely: the mapping below reshapes it to spec 03. */
export type SeedSettings = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/** Where the file is: WEST4_SEED_FILE, the repo's seed/ folder, or packages/db/seed in the API image. */
export function seedFilePath(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env["WEST4_SEED_FILE"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "..", "..", "..", "seed", "west4-friday.json"),
    path.resolve(here, "..", "seed", "west4-friday.json"),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error(`seed file not found; looked in ${candidates.join(", ")}`);
  return found;
}

export function readSeedFile(file: string = seedFilePath()): SeedFile {
  return JSON.parse(readFileSync(file, "utf8")) as SeedFile;
}

// ---------------------------------------------------------------- stable ids

/** The namespace every seed UUID is derived from (a fixed, arbitrary UUID). */
const SEED_NAMESPACE = "6f1a1c0e-5b3d-4b7e-9c2a-4d8e7f6a5b3c";

/**
 * The same UUID for the same slug on every load: a version 5 (SHA-1) UUID
 * of the slug under the seed namespace, so "maya" is one id everywhere.
 */
/** Rooms whose seed `note` is a staff note on the room (docs/demo-seed.md · Rooms), not an explanation. */
const STAFF_ROOM_NOTES = new Set(["room_6", "room_vip"]);

/** The staff app's room-code alphabet (apps/api/src/rooms/checkin.ts): no 0/O, 1/I, 5/S or 8/B. */
const ROOM_CODE_ALPHABET = "ACDEFGHJKMNPQRTUVWXY234679";

/** A seed session's room code, the same on every load, never with a digit of the room's number. */
export function seedRoomCode(slug: string, roomName: string): string {
  const banned = new Set(roomName.replace(/\D/g, "").split(""));
  const alphabet = [...ROOM_CODE_ALPHABET].filter((ch) => !banned.has(ch));
  const bytes = createHash("sha256").update(`room-code:${slug}`).digest();
  return Array.from({ length: 5 }, (_, i) => alphabet[bytes[i]! % alphabet.length]).join("");
}

/**
 * A seeded session's host link token (DEMO ONLY): what the Room code text's link carries, derived
 * from the session's slug so tests and demo scripts can open Marcus T.'s link.
 */
export function seedHostToken(slug: string): string {
  return createHash("sha256").update(`host-token:${slug}`).digest("base64url").slice(0, 32);
}

/** As the API hashes a room code (apps/api/src/rooms/checkin.ts · hashRoomCode). */
export const roomCodeHash = (venueId: string, code: string) =>
  createHash("sha256").update(`${venueId}:${code.toUpperCase()}`).digest("hex");

export function seedUuid(slug: string): string {
  const ns = Buffer.from(SEED_NAMESPACE.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(ns).update(slug).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------- production guard

export class SeedRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedRefused";
  }
}

/** The seed never runs against production: demo PINs, a simulated clock and a wiped venue have no place there. */
export function assertSeedAllowed(
  databaseUrl: string,
  env: Record<string, string | undefined> = process.env,
): void {
  if (env["WEST4_ENV"] === "production") {
    throw new SeedRefused("the demo seed never loads into production (WEST4_ENV=production)");
  }
  let host = "";
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    // an unparsable URL fails at connect time, not here
  }
  if (/prod/i.test(host)) {
    throw new SeedRefused(`the demo seed never loads into production (database host ${host})`);
  }
}

// ---------------------------------------------------------------- settings

const DAY_NUMBERS: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function dayNumber(day: unknown): number {
  const n = typeof day === "string" ? DAY_NUMBERS[day] : undefined;
  if (n === undefined) throw new Error(`seed: unknown day ${JSON.stringify(day)}`);
  return n;
}

/**
 * Cautious defaults for the fields spec 03 requires but neither the seed
 * nor the spec states for West 4 (ticket M1-17 Notes). Each is the value
 * that changes the least, and Admin can set the real one.
 */
export const SEED_SETTING_DEFAULTS = {
  billingRounding: "up",
  booking: { minHours: 1, maxHours: 12, startSlots: [] as string[] },
  depositLate: "keep",
  depositNoShow: "keep",
  drawerSecondCounter: "whenOff",
  drawerPaidOutApprovalCents: 0,
  roomsCleaningMin: 0,
} as const;

/**
 * The seed's settings block reshaped to spec 03's keys (the spec wins where
 * the seed's names differ): prices.billingStepMin → prices.billing.incrementMin,
 * tabs.flagCents → tabs.flagOverCents, rooms.cleaningEndsBy → rooms.cleaningEnds,
 * rooms.flagCleaningAfterMin → rooms.cleaningFlagMin,
 * barMode.songsPerSingerPerRound → barMode.songsPerRound,
 * occupancy.maxOccupancy → safety.occupancyLimit, minimumSpend → an empty
 * prices.minSpend. ordering.on is a module and ordering.cancelUntil a rule,
 * so both are dropped. A null stays null.
 */
export function mapSeedSettings(
  seed: Pick<SeedFile, "settings" | "venue">,
  maxGuests: number,
): Record<SettingsKey, unknown> {
  const s = seed.settings;
  const hours = s["hours"] ?? {};
  const prices = s["prices"] ?? {};
  const deposit = s["deposit"] ?? {};
  const pay = s["pay"] ?? {};
  const tabs = s["tabs"] ?? {};
  const pos = s["pos"] ?? {};
  const drawer = s["drawer"] ?? {};
  const ordering = s["ordering"] ?? {};
  const rooms = s["rooms"] ?? {};
  const barMode = s["barMode"] ?? {};
  const occupancy = s["occupancy"] ?? {};
  const tipScreen = (pay["tipScreen"] ?? {}) as Record<string, unknown>;
  const weekly = (hours["weekly"] ?? []) as { day: string; opens: string; closes: string }[];
  return {
    hours: {
      weekly: weekly.map((w) => ({ day: dayNumber(w.day), opens: w.opens, closes: w.closes })),
      lastCall: hours["lastCall"] ?? null,
    },
    prices: {
      rate: prices["rate"],
      billing: {
        incrementMin: prices["billingStepMin"],
        rounding: SEED_SETTING_DEFAULTS.billingRounding,
      },
      minGuests: prices["minGuests"],
      firstHourMinimum: prices["firstHourMinimum"],
      bands: [],
      // The seed names the VIP room by its slug; the setting holds the room's id.
      vip: prices["vip"]
        ? {
            ...(prices["vip"] as Record<string, unknown>),
            roomIds: ((prices["vip"] as { roomIds: string[] }).roomIds ?? []).map((slug) =>
              seedUuid(slug),
            ),
          }
        : null,
      minSpend: [],
      booking: { ...SEED_SETTING_DEFAULTS.booking, maxGuests },
      damageFeeCents: prices["damageFeeCents"],
    },
    deposit: {
      on: deposit["on"],
      mode: deposit["mode"],
      value: 0,
      refundHours: deposit["refundHours"],
      late: SEED_SETTING_DEFAULTS.depositLate,
      noShow: SEED_SETTING_DEFAULTS.depositNoShow,
      graceMin: deposit["graceMin"],
      bigParty: bigParty(deposit["bigParty"]),
    },
    pay: {
      cardFee: pay["cardFee"],
      gratuity: pay["gratuity"],
      tipScreen: {
        on: tipScreen["on"],
        pcts: tipScreen["pcts"],
        fixedCents: [100, 200, 300],
        smartThresholdCents: 1000,
      },
      tipReview: pay["tipReview"],
      pool: pay["pool"],
      roomHold: pay["roomHold"],
      payShare: { on: true },
    },
    drawer: {
      drawer: drawer["drawer"],
      startingBankCents: drawer["startingBankCents"],
      noteOverCents: drawer["noteOverCents"],
      secondCounter: SEED_SETTING_DEFAULTS.drawerSecondCounter,
      paidOutApprovalCents: SEED_SETTING_DEFAULTS.drawerPaidOutApprovalCents,
      perPerson: { who: "bartenders", countLater: false },
    },
    tabs: {
      openingHoldCents: tabs["openingHoldCents"],
      flagOverCents: tabs["flagCents"],
      cutOffAt: tabs["cutOffAt"],
    },
    pos: {
      layouts: {},
      reasonOnly: pos["reasonOnly"],
      idleLockMin: pos["idleLockMin"],
      wipeLockSec: pos["wipeLockSec"],
      barTabTip: pos["barTabTip"],
      orderAging: pos["orderAging"],
      chime: pos["chime"],
      muteSec: pos["muteSec"],
    },
    ordering: { hostLockDefault: ordering["hostLockDefault"] },
    rooms: {
      cleaningMin: SEED_SETTING_DEFAULTS.roomsCleaningMin,
      cleaningEnds: rooms["cleaningEndsBy"],
      cleaningFlagMin: rooms["flagCleaningAfterMin"],
      stayOnWhenFree: true,
    },
    barMode: {
      songPriceCents: barMode["songPriceCents"] ?? null,
      drinkCredit: true,
      freeNights: ((barMode["freeNights"] ?? []) as unknown[]).map(dayNumber),
      songsPerRound: barMode["songsPerSingerPerRound"],
      alerts: { beforeYou: 2, upNextText: true },
      upNextCount: 5,
    },
    alerts: { roomEndingMin: 10 },
    phone: { callNumber: seed.venue.phone_e164, textNumber: seed.venue.phone_e164 },
    website: { priceWording: "plusTaxAndGratuity" },
    // No reminder time is known for West 4: empty until Admin sets it, so no Reminder goes out (D87).
    messages: { reminderAt: null, offerExpiringMin: 5 },
    safety: { occupancyLimit: occupancy["maxOccupancy"] ?? null, warnAtPct: 90 },
    languages: { staff: ["en", "es"] },
  };
}

/** The seed's bigParty carries a minSpendCents (0 at West 4) that spec 03 keeps in prices.minSpend instead; it is dropped. */
function bigParty(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  const { fromGuests, deposit, refundHours } = raw as Record<string, unknown>;
  return { fromGuests, deposit, refundHours };
}

/** Every key parsed against its schema; a shape the spec refuses stops the load. */
export function parsedSeedSettings(
  values: Record<SettingsKey, unknown>,
): { key: SettingsKey; value: unknown }[] {
  const reasons: string[] = [];
  const out: { key: SettingsKey; value: unknown }[] = [];
  for (const key of settingsKeys) {
    const r = parseSetting(key, values[key]);
    if (r.ok) out.push({ key, value: r.value });
    else reasons.push(...r.reasons);
  }
  if (reasons.length > 0) throw new Error(`seed settings refused: ${reasons.join("; ")}`);
  return out;
}

// ---------------------------------------------------------------- modules

/** The seed's module names (Admin → Features' words) to the module ids of spec 03. */
export const SEED_MODULE_IDS: Readonly<Record<string, ModuleId>> = {
  website: "website",
  booking: "online_booking",
  waitlist: "waitlist",
  rooms: "rooms",
  roomOrdering: "room_ordering",
  barScreen: "bar_screen",
  barTabs: "bar_tabs",
  barMode: "bar_mode",
  packages: "packages",
  messages: "guest_texts",
  team: "team",
  safety: "safety",
  reports: "reports",
  kitchen: "kitchen",
  songControl: "song_system",
  marketing: "marketing_texts",
  events: "event_sales",
  crm: "guests_loyalty",
  multiLocation: "multi_location",
};

export interface SeedModuleRow {
  readonly moduleId: ModuleId;
  readonly allowed: boolean;
  readonly state: "on" | "off";
}

/** One row per named module: on or off as the seed says, allowed for the phase 1 modules and not for the phase 2 ones. */
export function mapSeedModules(
  venue: Pick<SeedFile["venue"], "modules_on" | "modules_off">,
): SeedModuleRow[] {
  const rows: SeedModuleRow[] = [];
  const add = (name: string, state: "on" | "off") => {
    const id = SEED_MODULE_IDS[name];
    if (id === undefined || !isModuleId(id)) throw new Error(`seed: unknown module ${name}`);
    const def = moduleDef(id);
    if (state === "on" && !def.phase1)
      throw new Error(`seed: ${name} is a phase 2 module and can't be on`);
    rows.push({ moduleId: id, allowed: def.phase1, state });
  };
  for (const name of venue.modules_on) add(name, "on");
  for (const name of venue.modules_off) add(name, "off");
  return rows;
}

// ---------------------------------------------------------------- permissions

/** The seed's prose rows (spec 02's table) to the action ids of packages/shared, matched by how each row starts. */
const PERMISSION_ROWS: readonly { starts: string; actions: readonly Action[] }[] = [
  { starts: "Take payments", actions: ["payments.take"] },
  { starts: "Bar POS", actions: ["pos.use"] },
  { starts: "Accept room orders", actions: ["orders.accept"] },
  {
    starts: "Check in",
    actions: ["guests.checkin", "waitlist.manage", "bookings.manage", "texts.send"],
  },
  { starts: "Carry runs", actions: ["runs.carry"] },
  { starts: "Comp or void", actions: ["comps.reasonOnly"] },
  { starts: "Cut off", actions: ["cutoff.apply"] },
  { starts: "Approve", actions: ["approvals.decide"] },
  { starts: "Ask for a refund", actions: ["refunds.request"] },
  { starts: "Count a drawer", actions: ["drawer.count"] },
  { starts: "Admin", actions: ["admin.access"] },
  { starts: "Shares tips", actions: ["tips.share"] },
];

/** "limited" on the check-in row means check-in and waitlist only (the seed's note). */
const LIMITED: Readonly<Partial<Record<Action, boolean>>> = {
  "guests.checkin": true,
  "waitlist.manage": true,
  "bookings.manage": false,
  "texts.send": false,
};

export interface SeedPermissionOverride {
  readonly role: Role;
  readonly action: Action;
  readonly allowed: boolean;
}

/**
 * The seed's table against the default one. A row is written only where they
 * differ (spec 03: no row means the default), so a seed that matches the
 * spec, as West 4's does, writes nothing.
 */
export function mapSeedPermissions(rows: readonly SeedPermissionRow[]): SeedPermissionOverride[] {
  const overrides: SeedPermissionOverride[] = [];
  const seen = new Set<Action>();
  for (const row of rows) {
    const match = PERMISSION_ROWS.find((p) => row.action.startsWith(p.starts));
    if (!match) throw new Error(`seed: no action for permission row "${row.action}"`);
    for (const action of match.actions) {
      seen.add(action);
      for (const role of roles) {
        const raw = row[role];
        const allowed = raw === "limited" ? (LIMITED[action] ?? false) : raw;
        if (allowed !== defaultPermissions[action][role]) overrides.push({ role, action, allowed });
      }
    }
  }
  const unmapped = actions.filter(
    (a) => !seen.has(a) && !a.startsWith("admin.") && a !== "night.close" && a !== "reports.view",
  );
  if (unmapped.length > 0)
    throw new Error(`seed: permission rows missing for ${unmapped.join(", ")}`);
  return overrides;
}

// ---------------------------------------------------------------- the load

export interface SeedLoadOptions {
  readonly databaseUrl: string;
  readonly log?: (line: string) => void;
  readonly env?: Record<string, string | undefined>;
  readonly file?: string;
}

export interface SeedLoadResult {
  readonly venueId: string;
  /** Every slug the load wrote, with its UUID. */
  readonly ids: Readonly<Record<string, string>>;
  readonly counts: {
    readonly memberships: number;
    readonly devices: number;
    readonly settings: number;
    readonly modules: number;
    readonly permissionOverrides: number;
    readonly menuItems: number;
  };
}

/** Load the M1 part of the demo seed. Wipes the venue's M1 rows first, so a second load gives the same rows and ids. */
/**
 * Loads the demo seed. The API's workers keep writing the night while it reloads (the job worker, the
 * sweeps, a screen's request), and a reload deletes most of the venue's rows in one transaction, so
 * Postgres can pick the reload as a deadlock's victim. The transaction is all or nothing, so the
 * reload simply starts again (up to three tries); two reloads never run at once (an advisory lock).
 */
export async function loadDemoSeed(options: SeedLoadOptions): Promise<SeedLoadResult> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await loadDemoSeedOnce(options);
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (attempt >= 3 || (code !== "40P01" && code !== "40001")) throw error;
      (options.log ?? (() => {}))(`seed: ${code === "40P01" ? "deadlock" : "conflict"}, retrying`);
    }
  }
}

/** The advisory lock that serializes every reload of the demo seed ("WES4"). */
export const SEED_LOCK_KEY = 0x5745_5334;

/** One reload, in one transaction. */
async function loadDemoSeedOnce(options: SeedLoadOptions): Promise<SeedLoadResult> {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => {});
  assertSeedAllowed(options.databaseUrl, env);
  const seed = readSeedFile(options.file ?? seedFilePath(env));
  const businessDate = seed.meta.business_date;

  const ids: Record<string, string> = {};
  const id = (slug: string): string => {
    ids[slug] ??= seedUuid(slug);
    return ids[slug];
  };
  const seedRows: { slug: string; entity: string; id: string }[] = [];
  const remember = (slug: string, entity: string): string => {
    const uuid = id(slug);
    seedRows.push({ slug, entity, id: uuid });
    return uuid;
  };

  const client = new pg.Client({
    connectionString: options.databaseUrl,
    application_name: "west4-seed",
  });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock($1)", [SEED_LOCK_KEY]);

    // The organization and the venue: West 4 Inc. (the founder's, Oct 2), or the venue's name if a seed has none.
    const orgId = remember("org_west4", "organizations");
    await client.query(
      `insert into organizations (id, legal_name) values ($1, $2)
       on conflict (id) do update set legal_name = excluded.legal_name`,
      [orgId, seed.venue.legal_name ?? seed.venue.name],
    );
    const venueId = remember(seed.venue.id, "venues");
    const [line1, city, state] = seed.venue.address.split(",").map((s) => s.trim());
    const dayCutover = (seed.settings["hours"]?.["dayCutover"] as string | undefined) ?? "06:00";
    await client.query(
      `insert into venues (id, org_id, name, slug, address, time_zone, day_cutover, rule_pack_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (id) do update set org_id = excluded.org_id, name = excluded.name, slug = excluded.slug,
         address = excluded.address, time_zone = excluded.time_zone, day_cutover = excluded.day_cutover,
         rule_pack_id = excluded.rule_pack_id`,
      [
        venueId,
        orgId,
        seed.venue.name,
        seed.venue.slug,
        JSON.stringify({
          line1,
          city,
          state,
          ...(seed.venue.postal_code ? { postal_code: seed.venue.postal_code } : {}),
        }),
        seed.venue.time_zone,
        dayCutover,
        seed.venue.rule_pack_id,
      ],
    );

    // A fresh Friday: everything this load owns goes first, children before parents.
    // Our pages (M8-17) are about the night being thrown away (its payment failures, its readers, its
    // synthetic orders), so a reload starts with none; the seed never runs in production.
    await client.query("delete from page_notifications");
    await client.query("delete from pages");
    await client.query("delete from push_subscriptions where venue_id = $1", [venueId]);
    await client.query(
      "delete from device_nonces where device_id in (select id from devices where venue_id = $1)",
      [venueId],
    );
    await client.query("update devices set cash_drawer_id = null where venue_id = $1", [venueId]);
    for (const table of [
      // Replayed offline orders (M8-05) name their orders and posted cash.
      "offline_replays",
      // Queued and finished jobs (M6-09): the seed's ids are the same on every load, so a job left from the
      // last night (a payment run keyed by its payment and attempt) would swallow tonight's as a duplicate.
      "jobs",
      "drawer_moves",
      "staff_banks",
      "drawer_sessions",
      "drawer_handovers",
      "cash_drawers",
      "order_drafts",
      "pin_lockouts",
      "staff_badges",
      "invites",
      "phone_codes",
      "device_pairing_codes",
      "router_failover_tests",
      "router_links",
      // A computer's offline-code secret (M8-04) names the computer.
      "device_offline_secrets",
      "device_heartbeats",
      // The mic power trial's log (M8-23) names its outlet.
      "mic_outlet_switches",
      // The staff trial's capture (M9-11) names its device.
      "trial_events",
      // The nightly money audit (M9-15) of a night the reload throws away.
      "money_audits",
      "vendor_calls",
      "vendor_health",
      // Our plan (M8-15): no subscription on the demo night; a test that makes one starts clean.
      "venue_subscriptions",
      "plan_subscribe_attempts",
      "print_jobs",
      // A card tapped for a room names its reader and its consent (M6-13).
      "check_cards",
      // A saved-card question names its reader (M6-12).
      "tab_card_confirms",
      // A tab's close names its reader (M6-08).
      "tab_closings",
      "devices",
      "closures",
      "door_counts",
      "waitlist_entries",
      // Incidents (M8-08): the notes before the incident, both before the room sessions.
      "incident_notes",
      // Imports (M9-01): their refs name rows this wipe removes, so a re-import after a reseed starts clean.
      "import_refs",
      "import_unplaced",
      "import_runs",
      "incidents",
      "room_calls",
      "room_faults",
      "room_notes",
      "lost_items",
      "alcohol_refusals",
      "bar_presence",
      "clear_out_checks",
      // The 4:30 AM tab cut-off, once a night (M6-16).
      "tab_cut_off_runs",
      // Bar mode (M6-18): credits point at songs, lines and payments; songs at singers and the night.
      "singer_push_subscriptions",
      "song_catalog",
      "song_plays",
      "song_queue_moves",
      "song_credits",
      "song_queue",
      "song_nights",
      "order_items",
      // A gift order names its singer (M6-24): orders go before singers.
      "orders",
      "singers",
      "room_guests",
      "menu_options",
      "modifier_groups",
      "menu_variants",
      "menu_items",
      "menu_categories",
      "packages",
      "price_rules",
      "room_blocks",
      "approvals",
      "id_checks",
      "id_scan_keys",
      "enquiries",
      "messages",
      "conversations",
      // Opt-ins and opt-outs (M5-08's marketing box names its guest): a fresh night starts with none.
      "consents",
      "message_templates",
      "webhook_events",
      "integrations",
      "setup_checks",
      "site_versions",
      "pos_layouts",
      "prepaid_ledger",
      "prepaid_accounts",
      "tab_openings",
      "owner_alerts",
      "dispute_funds",
      "disputes",
      "tip_shares",
      "tip_pool_occupations",
      "tip_pools",
      "tip_ledger",
      // Payouts (M7-16) name the payments they paid out, so they go before the payments.
      "payout_lines",
      "payouts",
      "refunds",
      "receipts",
      "pay_links",
      "payment_events",
      "payment_allocations",
      "split_shares",
      "check_splits",
      "payment_attempts",
      "payments",
      "check_revisions",
      "check_lines",
      "tabs",
      "checks",
      // The license register (M8-09) points at its copies: before the files. The seed has none.
      "licenses",
      // The Console's emergency actions (M8-11): a fresh night starts with none.
      "emergency_actions",
      // Photos (the slips' since M6-09); after every row that points at one.
      "files",
      "shifts",
      "time_punches",
      // The night's accounting journal (M7-15), one per night: left from the last run's close, it would
      // make tonight's close fail as a duplicate.
      "exports",
      "night_closes",
      "venue_counters",
      "session_segments",
      "room_sessions",
      // The confirmation texts' manage links (M5-10) point at their bookings.
      "booking_links",
      "bookings",
      "policy_versions",
      "guests",
      "room_states",
      "rooms",
      "venue_settings",
      "venue_modules",
      "role_permissions",
      "seed_ids",
      "memberships",
    ]) {
      await client.query(`delete from ${table} where venue_id = $1`, [venueId]);
    }

    // The team: a user and an active membership each. PINs arrive in M1-23, badges in M1-25.
    // Sign-in rows (M1-19) belong to the person, not the venue, so they're wiped by user id.
    const authKey =
      process.env["AUTH_SECRET_KEY"] ??
      ((process.env["WEST4_ENV"] ?? "local") === "local" ? LOCAL_DEV_AUTH_KEY : undefined);
    let totpLoaded = 0;
    let codeSetsLoaded = 0;
    let pinsLoaded = 0;
    for (const person of seed.team) {
      const userId = remember(person.id, "users");
      await client.query(
        // A fresh Friday: nobody's phone is verified yet, whatever an earlier run's invite did.
        `insert into users (id, name, email) values ($1, $2, $3)
         on conflict (id) do update set name = excluded.name, email = excluded.email,
           phone_e164 = null, phone_verified_at = null`,
        [userId, person.name, person.demo_email ?? null],
      );
      await client.query("delete from auth_challenges where user_id = $1", [userId]);
      await client.query("delete from auth_sessions where user_id = $1", [userId]);
      await client.query("delete from auth_credentials where user_id = $1", [userId]);
      await client.query("delete from owner_recoveries where user_id = $1", [userId]);
      await client.query("delete from recovery_codes where user_id = $1", [userId]);
      if (person.demo_recovery_codes && person.demo_recovery_codes.length > 0) {
        await client.query(
          `insert into recovery_codes (user_id, code_hash, created_at)
           select $1, unnest($2::text[]), now()`,
          [userId, person.demo_recovery_codes.map(recoveryCodeHash)],
        );
        codeSetsLoaded += 1;
      }
      if (person.demo_totp_secret && authKey) {
        await client.query(
          `insert into auth_credentials (user_id, kind, name, secret_enc) values ($1, 'totp', 'Demo authenticator', $2)`,
          [userId, encryptSecret(parseAuthSecretKey(authKey), person.demo_totp_secret)],
        );
        totpLoaded += 1;
      }
      const membershipId = remember(`${person.id}.membership`, "memberships");
      // DEMO ONLY (M1-23): the demo PINs become verifiers like real ones, never stored plain. The seed never runs in production.
      const verifier =
        authKey && person.demo_pin
          ? await pinVerifier(parseAuthSecretKey(authKey), venueId, membershipId, person.demo_pin)
          : null;
      if (verifier) pinsLoaded += 1;
      await client.query(
        `insert into memberships (id, venue_id, user_id, role, status, pin_digits, locale, pin_verifier)
         values ($1, $2, $3, $4, 'active', $5, $6, $7)`,
        [membershipId, venueId, userId, person.role, person.pin_digits, person.locale, verifier],
      );
    }
    // Badges (M1-25): the seed's four NTAG 424 DNA badges get fixed demo UIDs so the fake reader can tap them.
    // DEMO ONLY: real badges are paired in Admin → Team by tapping them on the reader.
    for (const badge of seed.badges) {
      await client.query(
        `insert into staff_badges (venue_id, membership_id, uid_hash, key_version, last_counter, label)
         values ($1, $2, $3, 1, 0, $4)`,
        [
          venueId,
          id(`${badge.person}.membership`),
          badgeUidHash(venueId, demoBadgeUid(badge.id)),
          badge.id,
        ],
      );
    }
    log(
      `team: ${seed.team.length} people` +
        (totpLoaded > 0
          ? `, ${totpLoaded} demo authenticator secrets`
          : authKey
            ? ""
            : " (demo authenticator secrets skipped: AUTH_SECRET_KEY not set)") +
        (codeSetsLoaded > 0 ? `, ${codeSetsLoaded} demo recovery code set` : "") +
        (pinsLoaded > 0 ? `, ${pinsLoaded} demo PIN verifiers` : "") +
        `, ${seed.badges.length} demo badges`,
    );

    // Settings: version 1 of every key, in force from the seed's business date.
    const maxGuests = largestRoom(seed);
    const settings = parsedSeedSettings(mapSeedSettings(seed, maxGuests));
    for (const { key, value } of settings) {
      await client.query(
        `insert into venue_settings (venue_id, key, version, value, starts_on) values ($1, $2, 1, $3, $4)`,
        [venueId, key, JSON.stringify(value), businessDate],
      );
    }
    log(`settings: ${settings.length} keys`);

    // The deposit policy guests accept (M5-06), version 1, built from the deposit and pay settings.
    const depositSetting = settings.find((x) => x.key === "deposit")?.value as
      DepositRule | undefined;
    const paySetting = settings.find((x) => x.key === "pay")?.value as PaySettings | undefined;
    if (depositSetting && paySetting)
      await publishPolicy(client, venueId, {
        text: depositPolicyText(depositSetting, paySetting.gratuity),
        at: SEED_NOW.toString(),
        by: null,
      });

    // The guest site (M5-01): West 4's words as published version 1, checked against the content schema.
    if (seed.site) {
      const content = siteContentSchema.parse(seed.site.content);
      await client.query(
        `insert into site_versions (venue_id, version, status, content, published_at)
         values ($1, $2, 'published', $3, $4)`,
        [venueId, seed.site.published_version, JSON.stringify(content), seed.meta.now],
      );
      log(`site: version ${seed.site.published_version} published`);
    }

    // Modules: on and off as Admin → Features shows, allowed by phase.
    const modules = mapSeedModules(seed.venue);
    for (const m of modules) {
      await client.query(
        `insert into venue_modules (venue_id, module_id, allowed, state) values ($1, $2, $3, $4)`,
        [venueId, m.moduleId, m.allowed, m.state],
      );
    }
    log(
      `modules: ${modules.filter((m) => m.state === "on").length} on, ${modules.filter((m) => m.state === "off").length} off`,
    );

    // Permissions: only rows that differ from the default table.
    const overrides = mapSeedPermissions(seed.role_permissions);
    for (const o of overrides) {
      await client.query(
        `insert into role_permissions (venue_id, role, action, allowed) values ($1, $2, $3, $4)`,
        [venueId, o.role, o.action, o.allowed],
      );
    }
    log(`permissions: ${overrides.length} rows differ from the default table`);

    // Rooms (M2-04): the 14 in four tiers, each with its state tonight. Room 4 is out of service for its fault.
    const seedNow = new Date(SEED_NOW.epochMilliseconds);
    for (const room of seed.rooms) {
      const roomId = remember(room.id, "rooms");
      await client.query(
        `insert into rooms (id, venue_id, name, size_tier, capacity_min, capacity_max, is_vip, bookable_online)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          roomId,
          venueId,
          room.name,
          room.size_tier,
          room.capacity_min,
          room.capacity_max,
          room.is_vip,
          !room.is_vip,
        ],
      );
      const reason =
        room.state === "out_of_service" ? (room.fault?.text ?? "Out of service") : null;
      const left = /left (\d{1,2}):(\d{2}) PM/.exec(room.board_label ?? "");
      const since =
        room.state === "out_of_service" && room.fault?.reported_on
          ? new Date(`${room.fault.reported_on}T12:00:00-04:00`)
          : room.state === "cleaning" && left
            ? new Date(`2026-09-25T${Number(left[1]) + 12}:${left[2]}:00-04:00`)
            : seedNow;
      await client.query(
        `insert into room_states (venue_id, room_id, state, reason, since) values ($1, $2, $3, $4, $5)`,
        [venueId, roomId, room.state, reason, since],
      );
      // Its note (M2-19): notes stay with the room; nobody on the seed is named as the writer. Only the notes
      // docs/demo-seed.md calls room notes load (Room 6's remote, the VIP room's cake); the other rooms' "note"
      // fields explain the scenario to the reader.
      if (room.note && STAFF_ROOM_NOTES.has(room.id))
        await client.query(
          "insert into room_notes (venue_id, room_id, text, added_at) values ($1, $2, $3, $4)",
          [venueId, roomId, room.note, seedNow],
        );
      // Its fault (M2-16): logged before tonight, so nobody on the seed is named as the reporter.
      if (room.fault)
        await client.query(
          `insert into room_faults (venue_id, room_id, text, reported_at, out_of_service) values ($1, $2, $3, $4, $5)`,
          [venueId, roomId, room.fault.text, since, room.fault.out_of_service ?? false],
        );
    }
    log(`rooms: ${seed.rooms.length}`);

    // Guests and bookings (M2-06): 17 guests, per venue; 11 bookings with their rooms, deposits and
    // statuses. They were booked online (the deposits were paid by card), with a 24-hour refund window.
    for (const g of seed.guests) {
      await client.query(
        `insert into guests (id, venue_id, name, phone_e164, email, locale) values ($1, $2, $3, $4, $5, $6)`,
        [
          remember(g.id, "guests"),
          venueId,
          g.name,
          g.phone_e164 ?? null,
          g.email ?? null,
          g.locale ?? "en",
        ],
      );
    }
    for (const b of seed.bookings) {
      const room = seed.rooms.find((r) => r.id === b.room)!;
      const starts = Temporal.Instant.from(b.starts_at);
      await client.query(
        `insert into bookings (id, venue_id, guest_id, room_id, size_tier, party_size, starts_at, ends_at, business_date,
           status, source, deposit_cents, refund_cutoff_at, running_late_until)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'web', $11, $12, $13)`,
        [
          remember(b.id, "bookings"),
          venueId,
          id(b.guest),
          id(b.room),
          room.size_tier,
          b.party_size,
          b.starts_at,
          b.ends_at,
          b.business_date,
          b.status,
          b.deposit_cents,
          starts.subtract({ hours: 24 }).toString(),
          b.running_late_until ?? null,
        ],
      );
    }
    log(`guests: ${seed.guests.length}, bookings: ${seed.bookings.length}`);

    // Who's on the clock at 10:41 PM (M7-01): Maya on Bar since 4:00 PM, Andy on Manager since 6:00 PM,
    // Diego on Front desk since 7:00 PM; Abhishek not on shift. Andy's open Manager shift makes him the manager on duty.
    for (const person of seed.team) {
      if (!person.shift) continue;
      await recordPunch(client, {
        venueId,
        membershipId: id(`${person.id}.membership`),
        kind: "clock_in",
        duty: person.shift.duty,
        at: Temporal.Instant.from(person.shift.clock_in),
        venue: { timeZone: seed.venue.time_zone, dayCutover },
      });
    }

    // The 14 texts (M2-09), in the spec's order; marketing ones off.
    for (const text of seed.texts) {
      const tpl = SEED_TEXT_TEMPLATES[text.id];
      if (!tpl) throw new Error(`no template wording for the seed's text ${text.id}`);
      await client.query(
        `insert into message_templates (venue_id, key, position, category, body, "on") values ($1, $2, $3, $4, $5, $6)`,
        [
          venueId,
          tpl.key,
          text.n,
          text.category,
          tpl.body,
          text.category === "marketing" ? false : text.on,
        ],
      );
    }
    log(`texts: ${seed.texts.length}`);

    // Room sessions and their clock segments (M2-07): the eight rooms in use at 10:41 PM.
    // check_id is the check's stable id; the checks themselves load in M3.
    // Each code is hashed for joining and sealed (M3-08) so joined phones can be shown a new one.
    const codeOf = (sess: SeedSession) =>
      sess.room_code ??
      seedRoomCode(sess.id, seed.rooms.find((r) => r.id === sess.room)?.name ?? "");
    for (const sess of seed.sessions) {
      await client.query(
        `insert into room_sessions (id, venue_id, room_id, booking_id, check_id, party_size, started_at, booked_end_at, business_date, guest_id,
                                    room_code_hash, token_version, room_code_enc, host_token_hash)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1, $12, $13)`,
        [
          id(sess.id),
          venueId,
          id(sess.room),
          sess.booking === null ? null : id(sess.booking),
          sess.check === null ? null : remember(sess.check, "checks"),
          sess.party_size,
          sess.started_at,
          sess.booked_end_at,
          sess.business_date,
          sess.guest ? id(sess.guest) : null,
          roomCodeHash(venueId, codeOf(sess)),
          authKey ? encryptSecret(parseAuthSecretKey(authKey), codeOf(sess)) : null,
          createHash("sha256").update(seedHostToken(sess.id)).digest("hex"),
        ],
      );
      for (const seg of sess.segments) {
        await client.query(
          `insert into session_segments (venue_id, session_id, room_id, started_at, ended_at, billable_guests, rate_kind, hourly_cents, paused)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            venueId,
            id(sess.id),
            id(sess.room),
            seg.started_at,
            seg.ended_at,
            seg.billable_guests,
            seg.rate_kind,
            seg.hourly_cents,
            seg.paused,
          ],
        );
      }
    }
    // ID checks (M2-12): one visual row per guest whose ID the front desk checked at check-in.
    let idRows = 0;
    for (const sess of seed.sessions) {
      for (let i = 0; i < (sess.ids_checked?.checked ?? 0); i++) {
        await client.query(
          `insert into id_checks (venue_id, session_id, checked_by, checked_at, method) values ($1, $2, $3, $4, 'visual')`,
          [venueId, id(sess.id), id("diego"), sess.started_at],
        );
        idRows++;
      }
    }
    log(`room sessions: ${seed.sessions.length}, ID checks: ${idRows}`);

    // Room calls (M2-20): the board alert "Room 9 called for another mic, 2 min ago".
    let calls = 0;
    for (const alert of (seed as { board_alerts?: { text: string }[] }).board_alerts ?? []) {
      const m = /^Room (\w+) called for another mic, (\d+) min ago/.exec(alert.text);
      if (!m) continue;
      const session = seed.sessions.find((x) => x.room === `room_${m[1]!.toLowerCase()}`);
      if (!session) continue;
      await client.query(
        "insert into room_calls (venue_id, session_id, kind, created_at) values ($1, $2, 'mic', $3)",
        [
          venueId,
          id(session.id),
          new Date(SEED_NOW.subtract({ minutes: Number(m[2]) }).epochMilliseconds),
        ],
      );
      calls++;
    }
    log(`room calls: ${calls}`);

    // The waitlist (M2-25; docs/demo-seed.md · Waitlist): Amara B. (7), Nadia K. (6) and Chris P. (3), added by staff.
    type SeedWait = {
      id: string;
      guest: string;
      party_size: number;
      joined_at: string;
      quoted_min: number | null;
      status: string;
    };
    const waiting = (seed as { waitlist?: SeedWait[] }).waitlist ?? [];
    const tierOf = (party: number) =>
      [...seed.rooms]
        .filter((r) => r.capacity_max >= party)
        .sort((a, b) => Number(a.is_vip) - Number(b.is_vip) || a.capacity_max - b.capacity_max)[0]!
        .size_tier;
    for (const w of waiting)
      await client.query(
        `insert into waitlist_entries (id, venue_id, guest_id, party_size, size_tier_needed, joined_at, quoted_min, status, source)
           values ($1, $2, $3, $4, $5, $6, $7, $8, 'staff')`,
        [
          remember(w.id, "waitlist_entries"),
          venueId,
          id(w.guest),
          w.party_size,
          tierOf(w.party_size),
          new Date(w.joined_at),
          w.quoted_min,
          w.status,
        ],
      );
    log(`waitlist: ${waiting.length}`);

    // Who was here earlier (M2-35): Ella S. in Room 6 and Yuki H. in Room 13 paid and left, which is why those rooms
    // need a wipe. The seed gives when they left, not when they came, so their sessions start and end then (flagged).
    type SeedEarlier = { room: string; guest: string; party_size: number; left_at: string };
    const earlier = (seed as { earlier_sessions?: SeedEarlier[] }).earlier_sessions ?? [];
    for (const e of earlier)
      await client.query(
        `insert into room_sessions (venue_id, room_id, guest_id, party_size, started_at, ended_at, business_date, token_version)
           values ($1, $2, $3, $4, $5, $5, '2026-09-25', 1)`,
        [venueId, id(e.room), id(e.guest), e.party_size, new Date(e.left_at)],
      );
    // And the earlier waitlist: Leo M. (4), seated into Room 5 at 10:00 PM. The seed has no join time; the entry
    // records the seating time for both (flagged).
    type SeedWaitEarlier = {
      id: string;
      guest: string;
      party_size: number;
      joined_at: string | null;
      status: string;
      seated_at: string;
    };
    const waitedEarlier = (seed as { waitlist_earlier?: SeedWaitEarlier[] }).waitlist_earlier ?? [];
    for (const w of waitedEarlier)
      await client.query(
        `insert into waitlist_entries (id, venue_id, guest_id, party_size, size_tier_needed, joined_at, status, source, ended_at)
           values ($1, $2, $3, $4, $5, $6, $7, 'staff', $8)`,
        [
          remember(w.id, "waitlist_entries"),
          venueId,
          id(w.guest),
          w.party_size,
          tierOf(w.party_size),
          new Date(w.joined_at ?? w.seated_at),
          w.status,
          new Date(w.seated_at),
        ],
      );
    log(`earlier: ${earlier.length} sessions, ${waitedEarlier.length} seated from the waitlist`);

    // The inbox (M2-22; docs/demo-seed.md · Inbox threads): Sam O.'s unread "running 15 late", and Marcus T.'s
    // and Bianca L.'s threads. Texts without a time in the seed keep their order but show no time.
    type SeedThread = {
      id: string;
      guest: string;
      context: string;
      unread: boolean;
      messages: { dir: "in" | "out" | "auto"; at: string | null; body: string }[];
    };
    const threads = (seed as { inbox?: SeedThread[] }).inbox ?? [];
    const confirmed = (
      await client.query<{ id: string }>(
        "select id from message_templates where venue_id = $1 and key = 'booking_confirmed'",
        [venueId],
      )
    ).rows[0]?.id;
    let threadMessagesCount = 0;
    for (const [n, th] of threads.entries()) {
      const guest = seed.guests.find((g) => g.id === th.guest);
      if (!guest?.phone_e164) continue;
      const [kind, ref] = th.context.split(" ").slice(-2) as [string, string];
      const contextKind = th.context.startsWith("room session") ? "session" : kind;
      const unread = th.messages.filter((m) => m.dir === "in").length;
      const conversationId = remember(th.id, "conversations");
      // Unknown times: a minute apart, before the first known one, so the order holds.
      const base = SEED_NOW.subtract({ minutes: 60 + (threads.length - n) * 10 });
      const times = th.messages.map((m, i) =>
        m.at ? Temporal.Instant.from(m.at) : base.add({ minutes: i }),
      );
      const lastIn = th.messages
        .map((m, i) => (m.dir === "in" ? times[i]! : null))
        .filter(Boolean)
        .at(-1);
      await client.query(
        `insert into conversations (id, venue_id, guest_id, phone_e164, context_kind, context_id, unread, last_inbound_at, created_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          conversationId,
          venueId,
          id(th.guest),
          guest.phone_e164,
          contextKind,
          id(ref),
          th.unread ? unread : 0,
          lastIn ? new Date(lastIn.epochMilliseconds) : null,
          new Date(times[0]!.epochMilliseconds),
        ],
      );
      for (const [i, m] of th.messages.entries()) {
        const at = new Date(times[i]!.epochMilliseconds);
        await client.query(
          `insert into messages (venue_id, conversation_id, direction, template_id, category, body, status, sent_at, read_at, created_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            venueId,
            conversationId,
            m.dir === "in" ? "inbound" : "outbound",
            m.dir === "auto" ? (confirmed ?? null) : null,
            m.dir === "in" ? "reply" : m.dir === "auto" ? "service" : "reply",
            m.body,
            m.dir === "in" ? "received" : "delivered",
            m.at ? at : null,
            m.dir === "in" && !th.unread ? at : null,
            at,
          ],
        );
        threadMessagesCount++;
      }
    }
    log(`inbox: ${threads.length} threads, ${threadMessagesCount} texts`);

    // Checks (M2-08): all 13, numbered in the order they opened, with Room 9's #1042 fixed; their lines in
    // order, a comp pointing at the line it reverses. Room checks were opened by the front desk, bar checks by
    // the bartender. The counter then carries on from the last number.
    const opened = [...seed.checks].sort(
      (a, b) => a.opened_at.localeCompare(b.opened_at) || a.id.localeCompare(b.id),
    );
    const fixed = opened.findIndex((ch) => ch.number !== null);
    const base = fixed >= 0 ? opened[fixed]!.number! - fixed : 1;
    const session = (slug: string) => seed.sessions.find((x) => x.id === slug);
    const lineIds = new Map<string, number>();
    // A line sold from an order points at its order item (source_id): the order's items in line order.
    const orderLineCount = new Map<string, number>();
    const orderItemOf = (orderSlug: string) => {
      const n = orderLineCount.get(orderSlug) ?? 0;
      orderLineCount.set(orderSlug, n + 1);
      return id(`order_${orderSlug}_item_${n}`);
    };
    for (const [i, ch] of opened.entries()) {
      const sess = ch.room_session ? session(ch.room_session) : undefined;
      const checkId = ch.kind === "room" ? id(ch.id) : remember(ch.id, "checks");
      await client.query(
        `insert into checks (id, venue_id, number, kind, business_date, room_session_id, booking_id, status, opened_by, opened_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          checkId,
          venueId,
          base + i,
          ch.kind,
          ch.business_date,
          sess ? id(sess.id) : null,
          sess?.booking ? id(sess.booking) : null,
          ch.status,
          id(ch.kind === "room" ? "diego" : "maya"),
          ch.opened_at,
        ],
      );
      for (const line of ch.lines ?? []) {
        const r = await client.query<{ id: string }>(
          `insert into check_lines (venue_id, check_id, kind, description, qty, unit_cents, amount_cents, tax_category,
             business_date, reverses_id, made, reason, added_by, added_at, source_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) returning id`,
          [
            venueId,
            checkId,
            line.kind,
            line.description,
            line.qty,
            line.unit_cents,
            line.amount_cents,
            line.tax_category,
            ch.business_date,
            line.comp_of ? (lineIds.get(line.comp_of) ?? null) : null,
            line.made ?? null,
            line.reason ?? null,
            line.by ? id(line.by) : null,
            line.added_at ?? line.delivered_at ?? ch.opened_at,
            line.order ? orderItemOf(line.order) : null,
          ],
        );
        lineIds.set(line.id, Number(r.rows[0]!.id));
      }
      await client.query("update checks set version = $3 where venue_id = $1 and id = $2", [
        venueId,
        checkId,
        (ch.lines ?? []).length,
      ]);
    }
    await client.query(
      `insert into venue_counters (venue_id, name, next) values ($1, 'check', $2)`,
      // The paper slips' bar checks (M6-09) take the next numbers.
      [venueId, base + opened.length + seed.tip_slips.length],
    );
    const slipBase = base + opened.length;
    log(`checks: ${opened.length}, from #${base} to #${base + opened.length - 1}`);

    // The bar tabs (M6-02), on their bar checks, each on its hold (M6-16: Charge the remaining tabs and the
    // cut-off capture them): an authorized card_present payment for the tab's hold, the opening hold raised
    // once where the tab's hold grew (Luis M.'s $50 to $80; Tariq A.'s to $100, since every tab opens at $50). Its PaymentIntent on Stripe comes from
    // `stripe:seed`, as the slips' do; a fresh id on every load, for the same reason. Until then there is
    // no PaymentIntent to raise, so the hold reads as one that can't grow (capped at the hold plus the
    // overcapture allowance); `stripe:seed` writes what Stripe says the card supports.
    const tabOpeningHold = Number((seed.settings["tabs"] ?? {})["openingHoldCents"] ?? 0);
    for (const t of seed.bar_tabs) {
      const holdId = randomUUID();
      ids[`pay_${t.id}`] = holdId;
      seedRows.push({ slug: `pay_${t.id}`, entity: "payments", id: holdId });
      await client.query(
        `insert into payments (id, venue_id, method, status, amount_cents, authorized_cents, card_brand, card_last4,
           card_funding, business_date, incremental_supported, overcapture_supported, increments_used)
         values ($1, $2, 'card_present', 'authorized', 0, $3, $4, $5, 'credit', $6, false, true, $7)`,
        [
          holdId,
          venueId,
          t.hold_cents,
          t.card_brand.toLowerCase(),
          t.card_last4,
          seed.meta.business_date,
          t.hold_cents > tabOpeningHold ? 1 : 0,
        ],
      );
      await client.query(
        "insert into payment_events (venue_id, payment_id, from_status, to_status, source) values ($1, $2, null, 'authorized', 'api')",
        [venueId, holdId],
      );
      await client.query(
        `insert into tabs (id, venue_id, check_id, state, name, label, card_brand, card_last4, hold_cents,
           owner_id, opened_by, opened_at, cut_off_at, cut_off_by, payment_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11, $12, $13, $14)`,
        [
          remember(t.id, "tabs"),
          venueId,
          id(t.check),
          t.state,
          t.name,
          t.label ?? null,
          t.card_brand,
          t.card_last4,
          t.hold_cents,
          id(t.owner),
          t.opened_at,
          t.cut_off_at ?? null,
          t.cut_off_by ? id(t.cut_off_by) : null,
          holdId,
        ],
      );
    }
    log(`tabs: ${seed.bar_tabs.length}`);

    // Bar mode's queue (M6-18): the seven singers, confirmed when bar mode started; the night's row (round 3,
    // 23 sung); Luis M. singing on a credit (his $0.00 song line is ln_t2_3) and six up next, all in round 3.
    // Credits: each drink unit on a singer's tab earned one (none for the comped Jäger Bomb); the seed gives
    // how many each singer still holds, so the earlier units were spent on the songs before tonight's 10:41 PM
    // (the seed doesn't name those songs; their time is the drink's). Kira's and Ben T.'s credits came from
    // drinks bought at the bar, whose quick sales aren't in the seed, so they name no line (flagged for M6-27).
    // Each queued song holds one of its singer's credits; Sofia R. has none, so hers is flagged.
    const q = seed.song_queue;
    const songStart = q.bar_mode_started_at;
    await client.query(
      "insert into song_nights (venue_id, business_date, started_at, songs_sung) values ($1, $2, $3, $4)",
      [venueId, businessDate, songStart, q.songs_sung_so_far],
    );
    for (const sg of seed.singers)
      await client.query(
        `insert into singers (id, venue_id, display_name, phone_e164, phone_verified_at, check_id, joined_at, last_song_at)
         values ($1, $2, $3, $4, $5, $6, $5, $7)`,
        [
          remember(sg.id, "singers"),
          venueId,
          sg.name,
          sg.phone_e164,
          songStart,
          sg.check ? id(sg.check) : null,
          sg.id === q.now_singing.singer ? q.now_singing.started_at : null,
        ],
      );
    const songs = [
      { slug: `song_${q.now_singing.singer}`, ...q.now_singing, position: 1, status: "singing" },
      ...q.up_next.map((u) => ({
        slug: `song_${u.singer}`,
        ...u,
        position: u.position + 1,
        status: "queued",
        started_by: null,
        started_at: null,
      })),
    ];
    for (const song of songs) {
      const sg = seed.singers.find((x) => x.id === song.singer)!;
      await client.query(
        `insert into song_queue (id, venue_id, business_date, singer_id, check_id, title, artist, round, position, status,
           pay_with, queued_at, started_by, started_at, check_line_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'credit', $11, $12, $13, $14)`,
        [
          remember(song.slug, "song_queue"),
          venueId,
          businessDate,
          id(sg.id),
          sg.check ? id(sg.check) : null,
          song.title,
          song.artist,
          q.round,
          song.position,
          song.status,
          songStart,
          song.started_by ? id(song.started_by) : null,
          song.started_at,
          song.status === "singing"
            ? (lineIds.get(
                (seed.checks.find((c) => c.id === sg.check)?.lines ?? []).find(
                  (l) => l.kind === "song",
                )?.id ?? "",
              ) ?? null)
            : null,
        ],
      );
    }
    let creditCount = 0;
    for (const sg of seed.singers) {
      const lines = sg.check ? (seed.checks.find((c) => c.id === sg.check)?.lines ?? []) : [];
      const reversed = (lineSlug: string) =>
        lines
          .filter((l) => (l.kind === "comp" || l.kind === "void") && l.comp_of === lineSlug)
          .reduce((n, l) => n + l.qty, 0);
      const units = lines
        .filter((l) => l.kind === "item" && l.tax_category === "drink")
        .flatMap((l) =>
          Array.from({ length: Math.max(0, l.qty - reversed(l.id)) }, (_, k) => ({
            line: lineIds.get(l.id)!,
            unit: k + 1,
            at: l.added_at ?? seed.checks.find((c) => c.id === sg.check)!.opened_at,
          })),
        );
      // Bought at the bar, with no line here: one unit for each credit held.
      const earned = sg.check
        ? units
        : Array.from({ length: sg.credits }, () => ({ line: null, unit: null, at: songStart }));
      const spent = earned.length - sg.credits;
      if (spent < 0) throw new Error(`seed: ${sg.id} holds more credits than drinks earned`);
      const singing = q.now_singing.singer === sg.id;
      const queued = songs.find((x) => x.singer === sg.id && x.status === "queued");
      for (const [k, e] of earned.entries()) {
        const creditId = randomUUID();
        // The last spent credit is the song now singing's; the first one held is the queued song's.
        const usedBy =
          k === spent - 1 && singing
            ? id(`song_${sg.id}`)
            : k === spent && queued
              ? id(queued.slug)
              : null;
        const usedAt =
          k < spent ? (k === spent - 1 && singing ? q.now_singing.started_at : e.at) : null;
        await client.query(
          `insert into song_credits (id, venue_id, singer_id, source, check_line_id, unit, earned_at, used_by_queue_id, used_at)
           values ($1, $2, $3, 'drink', $4, $5, $6, $7, $8)`,
          [creditId, venueId, id(sg.id), e.line, e.unit, e.at, usedBy, usedAt],
        );
        if (usedBy)
          await client.query(
            "update song_queue set credit_id = $3 where venue_id = $1 and id = $2",
            [venueId, usedBy, creditId],
          );
        creditCount += 1;
      }
    }
    // The play log (M6-19): Luis M.'s song, started by Maya at 10:39 PM on his tab.
    const singingNow = seed.singers.find((x) => x.id === q.now_singing.singer)!;
    await client.query(
      `insert into song_plays (venue_id, business_date, queue_id, singer_id, check_id, title, artist, started_at,
         started_by, source)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'staff')`,
      [
        venueId,
        businessDate,
        id(`song_${q.now_singing.singer}`),
        id(singingNow.id),
        singingNow.check ? id(singingNow.check) : null,
        q.now_singing.title,
        q.now_singing.artist,
        q.now_singing.started_at,
        q.now_singing.started_by ? id(q.now_singing.started_by) : null,
      ],
    );
    log(`singers: ${seed.singers.length}, songs: ${songs.length}, credits: ${creditCount}`);

    // The paper tip slips (M6-09; screens N26): three bar tabs whose slips printed and were signed, waiting
    // as awaiting_tip with their holds standing, each with the photo of its signed slip. The brief gives each
    // tab's total, not its drinks, and none of the totals can be reached by drinks plus 8.875% tax, so each
    // check carries its total as one "Bar tab" line with no tax category (flagged for M6-27). The hold is the
    // venue's opening hold; its PaymentIntent on Stripe comes from `stripe:seed`, as the deposits' do.
    const openingHold = Number((seed.settings["tabs"] ?? {})["openingHoldCents"] ?? 0);
    for (const [i, slip] of seed.tip_slips.entries()) {
      const name = slip.name.replace(/^Bar tab · /, "");
      const checkId = remember(`chk_${slip.id}`, "checks");
      await client.query(
        `insert into checks (id, venue_id, number, kind, business_date, status, opened_by, opened_at)
           values ($1, $2, $3, 'bar', $4, 'finalized', $5, $6)`,
        [checkId, venueId, slipBase + i, seed.meta.business_date, id("maya"), slip.signed_at],
      );
      await client.query(
        `insert into check_lines (venue_id, check_id, kind, description, qty, unit_cents, amount_cents, tax_category,
           business_date, added_by, added_at)
         values ($1, $2, 'item', 'Bar tab', 1, $3, $3, null, $4, $5, $6)`,
        [
          venueId,
          checkId,
          slip.tab_total_cents,
          seed.meta.business_date,
          id("maya"),
          slip.signed_at,
        ],
      );
      // A fresh id on every load: Stripe keys are built from the payment's id (its capture's, for one), and
      // a reload against the same Stripe must never reuse last load's keys for a new hold.
      const paymentId = randomUUID();
      ids[`pay_${slip.id}`] = paymentId;
      seedRows.push({ slug: `pay_${slip.id}`, entity: "payments", id: paymentId });
      await client.query(
        `insert into payments (id, venue_id, method, status, amount_cents, authorized_cents, card_brand, card_last4,
           card_funding, business_date, incremental_supported, overcapture_supported)
         values ($1, $2, 'card_present', 'authorized', 0, $3, $4, $5, 'credit', $6, true, true)`,
        [
          paymentId,
          venueId,
          openingHold,
          slip.card_brand.toLowerCase(),
          slip.card_last4,
          seed.meta.business_date,
        ],
      );
      await client.query(
        "insert into payment_events (venue_id, payment_id, from_status, to_status, source) values ($1, $2, null, 'authorized', 'api')",
        [venueId, paymentId],
      );
      const tabId = remember(slip.id, "tabs");
      await client.query(
        `insert into tabs (id, venue_id, check_id, payment_id, state, name, card_brand, card_last4, hold_cents,
           owner_id, opened_by, opened_at)
         values ($1, $2, $3, $4, 'awaiting_tip', $5, $6, $7, $8, $9, $9, $10)`,
        [
          tabId,
          venueId,
          checkId,
          paymentId,
          name,
          slip.card_brand,
          slip.card_last4,
          openingHold,
          id("maya"),
          slip.signed_at,
        ],
      );
      // The photo's row; its image (a stand-in, since the brief has none) goes in the object store with
      // `seed:files` (M6-27), which also writes its size.
      const photoId = slip.photo_saved ? remember(`${slip.id}.photo`, "files") : null;
      if (photoId)
        await client.query(
          `insert into files (id, venue_id, kind, storage_key, content_type, bytes, uploaded_by, uploaded_at,
             attached_at)
           values ($1, $2, 'slip_photo', $5, 'image/png', 1, $3, $4, $4)`,
          [photoId, venueId, id("maya"), slip.signed_at, `${venueId}/slip_photo/${photoId}`],
        );
      await client.query(
        `insert into tab_closings (venue_id, tab_id, check_id, payment_id, path, state, balance_cents, drinks_cents,
           closed_by, created_at, slip_printed_at, slip_photo_file_id)
         values ($1, $2, $3, $4, 'slip', 'slip', $5, $5, $6, $7, $7, $8)`,
        [
          venueId,
          tabId,
          checkId,
          paymentId,
          slip.tab_total_cents,
          id("maya"),
          slip.signed_at,
          photoId,
        ],
      );
    }
    log(`paper tip slips: ${seed.tip_slips.length}`);

    // Deposits (M4-10; Money rules 11): each booking's captured deposit is a card_online payment, with the
    // card the brief names for display. A seated party's deposit is allocated to its check, following the
    // lines; the rest are money held for the guest until check-in. The PaymentIntents behind them are made
    // by `pnpm --filter @west4/api stripe:seed` (Stripe's sandbox, or the fake), never here.
    let deposits = 0;
    for (const b of seed.bookings) {
      const cents = b.deposit_captured_cents ?? 0;
      if (cents <= 0) continue;
      const paymentId = remember(`pay_${b.id}`, "payments");
      await client.query(
        `insert into payments (id, venue_id, booking_id, method, status, amount_cents, card_brand, card_last4,
           card_funding, business_date)
         values ($1, $2, $3, 'card_online', 'captured', $4, $5, $6, $7, $8)`,
        [
          paymentId,
          venueId,
          id(b.id),
          cents,
          b.deposit_card ? b.deposit_card.brand.toLowerCase() : null,
          b.deposit_card?.last4 ?? null,
          b.deposit_card ? "credit" : null,
          b.business_date,
        ],
      );
      await client.query(
        "insert into payment_events (venue_id, payment_id, from_status, to_status, source) values ($1, $2, null, 'captured', 'api')",
        [venueId, paymentId],
      );
      const seated = seed.sessions.find((x) => x.booking === b.id && x.check);
      if (seated?.check)
        await client.query(
          `insert into payment_allocations (venue_id, payment_id, check_id, amount_cents, kind, state, follows_lines)
           values ($1, $2, $3, $4, 'payment', 'captured', true)`,
          [venueId, paymentId, id(seated.check), cents],
        );
      deposits += 1;
    }
    log(`deposits: ${deposits}`);

    // Room blocks (M2-05): every confirmed booking's time (cleaning is 0 at West 4); every session from
    // its start to its booked end, or an hour for a walk-in, extended 15 minutes at a time to cover
    // 10:41 PM where it stayed on; the two rooms cleaning since their party left; Room 4's fault.
    const cleaningMin = SEED_SETTING_DEFAULTS.roomsCleaningMin;
    const block = async (
      room: string,
      kind: string,
      from: Temporal.Instant,
      to: Temporal.Instant | null,
      ref: string | null,
    ) =>
      client.query(
        `insert into room_blocks (venue_id, room_id, kind, period, ref_id)
           values ($1, $2, $3, tstzrange($4::timestamptz, $5::timestamptz, '[)'), $6)`,
        [venueId, id(room), kind, from.toString(), to?.toString() ?? null, ref],
      );
    let blocks = 0;
    for (const b of seed.bookings.filter((x) => x.status === "confirmed")) {
      await block(
        b.room,
        "booking",
        Temporal.Instant.from(b.starts_at),
        Temporal.Instant.from(b.ends_at).add({ minutes: cleaningMin }),
        id(b.id),
      );
      blocks++;
    }
    for (const sess of seed.sessions) {
      const start = Temporal.Instant.from(sess.started_at);
      // The planned end (a walk-in has one too), or an hour; then 15 minutes at a time to cover 10:41 PM.
      let end = sess.booked_end_at
        ? Temporal.Instant.from(sess.booked_end_at)
        : start.add({ minutes: 60 });
      while (Temporal.Instant.compare(end, SEED_NOW) <= 0) end = end.add({ minutes: 15 });
      await block(
        sess.room,
        "session",
        start,
        end.add({ minutes: cleaningMin }),
        remember(sess.id, "sessions"),
      );
      blocks++;
    }
    for (const room of seed.rooms) {
      if (room.state === "cleaning") {
        const left = /left (\d{1,2}):(\d{2}) PM/.exec(
          (room as { board_label?: string }).board_label ?? "",
        );
        const since = left
          ? Temporal.Instant.from(
              `2026-09-25T${String(Number(left[1]) + 12).padStart(2, "0")}:${left[2]}:00-04:00`,
            )
          : SEED_NOW;
        // The block covers the room's cleaning minutes (M2-19); the room's state stays cleaning until staff mark it clean.
        if (cleaningMin > 0) {
          await block(room.id, "cleaning", since, since.add({ minutes: cleaningMin }), null);
          blocks++;
        }
      }
      if (room.state === "out_of_service") {
        const since = room.fault?.reported_on
          ? Temporal.Instant.from(`${room.fault.reported_on}T12:00:00-04:00`)
          : SEED_NOW;
        await block(room.id, "out_of_service", since, null, null);
        blocks++;
      }
    }
    log(`room blocks: ${blocks}`);

    // The menu: one category per section in the seed's order, one "Regular" variant per item
    // carrying its price, and each item's own copy of its choice group. A spirit's "How" group
    // defaults to Rocks, and its mixers are a second, optional group. 86'd items are out until
    // the end of the business date, the next 6:00 AM.
    const sections = [...new Set(seed.menu.items.map((i) => i.section))];
    const categoryIds = new Map<string, string>();
    for (const [n, section] of sections.entries()) {
      const categoryId = remember(`menu_section_${section}`, "menu_categories");
      categoryIds.set(section, categoryId);
      await client.query(
        "insert into menu_categories (id, venue_id, name, sort, tax_category) values ($1, $2, $3, $4, 'drink')",
        [categoryId, venueId, section, n],
      );
    }
    const outUntil = Temporal.PlainDate.from(businessDate)
      .add({ days: 1 })
      .toZonedDateTime({ timeZone: seed.venue.time_zone, plainTime: dayCutover })
      .toString({ timeZoneName: "never" });
    const out = new Set(seed.menu.out_tonight);
    for (const [n, item] of seed.menu.items.entries()) {
      const itemId = remember(`menu_${item.id}`, "menu_items");
      await client.query(
        `insert into menu_items (id, venue_id, category_id, name, alcohol, sort, out_until)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          itemId,
          venueId,
          categoryIds.get(item.section),
          item.name,
          item.alcohol,
          n,
          out.has(item.id) ? outUntil : null,
        ],
      );
      await client.query(
        "insert into menu_variants (id, venue_id, item_id, name, price_cents) values ($1, $2, $3, 'Regular', $4)",
        [remember(`menu_${item.id}_regular`, "menu_variants"), venueId, itemId, item.unit_cents],
      );
      const group =
        item.option_group === null ? undefined : seed.menu.option_groups[item.option_group];
      if (!group) continue;
      const addGroup = async (
        key: string,
        name: string,
        required: boolean,
        choices: readonly (readonly [string, number])[],
        byDefault: string | undefined,
        sort: number,
      ) => {
        const groupId = remember(`menu_${item.id}_${key}`, "modifier_groups");
        await client.query(
          `insert into modifier_groups (id, venue_id, item_id, name, required, min_choices, max_choices, sort)
           values ($1, $2, $3, $4, $5, $6, 1, $7)`,
          [groupId, venueId, itemId, name, required, required ? 1 : 0, sort],
        );
        for (const [o, [choice, delta]] of choices.entries()) {
          await client.query(
            `insert into menu_options (venue_id, item_id, group_id, name, price_delta_cents, is_default, sort)
             values ($1, $2, $3, $4, $5, $6, $7)`,
            [venueId, itemId, groupId, choice, delta, choice === byDefault, o],
          );
        }
      };
      await addGroup(
        item.option_group!,
        group.label,
        group.required,
        group.choices.map((c) => [c, 0] as const),
        group.default,
        0,
      );
      if (group.mixers)
        await addGroup(`${item.option_group!}_mixer`, "Mixer", false, group.mixers, undefined, 1);
    }
    log(`menu: ${seed.menu.items.length} items in ${sections.length} sections, ${out.size} 86'd`);

    // The bar POS layout (M6-01): version 1, in force from the seed's business date.
    const layout = Object.fromEntries(
      Object.entries(WEST4_POS_LAYOUT).map(([section, slots]) => [
        section,
        slots.map((item) => (item === null ? null : id(`menu_${item}`))),
      ]),
    );
    await client.query(
      `insert into pos_layouts (venue_id, station, version, status, sections, published_at, starts_on)
       values ($1, 'bar', 1, 'published', $2, $3, $4)`,
      [venueId, JSON.stringify(layout), SEED_NOW.toString(), businessDate],
    );
    await client.query(
      `update venue_settings set value = jsonb_set(value, '{layouts}', '{"bar": 1}')
        where venue_id = $1 and key = 'pos'`,
      [venueId],
    );

    // Room orders (M3-06): o1 and o2 ringing, o3 and o4 accepted and ready with their tickets
    // printed, and the earlier delivered ones, whose lines are on their checks already. The seed
    // gives the earlier ones' delivery time only, so it stands in for when they were placed and accepted.
    const seedMenuItem = (itemId: string) => seed.menu.items.find((i) => i.id === itemId);
    for (const o of seed.orders) {
      const orderId = remember(`order_${o.id}`, "orders");
      const placedAt = o.placed_at ?? o.accepted_at ?? o.delivered_at!;
      const acceptedAt =
        o.accepted_at ?? (o.status === "delivered" ? (o.delivered_at ?? null) : null);
      await client.query(
        `insert into orders (id, venue_id, check_id, session_id, source, status, cancel_reason, placed_at, business_date,
           accepted_by, accepted_at, ready_by, ready_at, delivered_by, delivered_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          orderId,
          venueId,
          id(o.check),
          id(o.session),
          o.source,
          o.status,
          o.cancel_reason,
          placedAt,
          businessDate,
          o.accepted_by ? id(o.accepted_by) : null,
          acceptedAt,
          o.ready_at && o.accepted_by ? id(o.accepted_by) : null,
          o.ready_at ?? null,
          o.delivered_by ? id(o.delivered_by) : null,
          o.delivered_at ?? null,
        ],
      );
      for (const [n, item] of o.items.entries()) {
        const menuItem = seedMenuItem(item.item_id);
        const group = menuItem?.option_group
          ? seed.menu.option_groups[menuItem.option_group]
          : undefined;
        const options = Object.values(item.options ?? {}).map((name) => ({
          group: group?.label ?? "",
          name,
          price_delta_cents: 0,
        }));
        await client.query(
          `insert into order_items (id, venue_id, order_id, variant_id, item_id, options, qty, unit_cents, name_snapshot,
             alcohol, tax_category, station, sort)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'drink', 'bar', $11)`,
          [
            remember(`order_${o.id}_item_${n}`, "order_items"),
            venueId,
            orderId,
            menuItem ? id(`menu_${item.item_id}_regular`) : null,
            menuItem ? id(`menu_${item.item_id}`) : null,
            JSON.stringify(options),
            item.qty,
            item.unit_cents,
            item.name,
            item.alcohol,
            n,
          ],
        );
      }
      if (o.ticket_printed && acceptedAt) {
        await client.query(
          `insert into print_jobs (venue_id, order_id, kind, station, payload, status, created_at, confirmed_at)
           values ($1, $2, 'ticket', 'bar', $3, 'printed', $4, $4)`,
          [
            venueId,
            orderId,
            JSON.stringify({
              order_id: orderId,
              lines: o.items.map((i) => ({
                qty: i.qty,
                name: i.name,
                options: Object.values(i.options ?? {}),
              })),
            }),
            acceptedAt,
          ],
        );
      }
    }
    log(`orders: ${seed.orders.length}`);

    // Unsent drafts (M3-25): Diego's Red Bull on Tariq A.'s tab, keyed by his membership and the tab's check.
    const tabCheck = (tab: string) => {
      const t = seed.bar_tabs.find((x) => x.id === tab);
      if (!t) throw new Error(`seed: no tab ${tab}`);
      return id(t.check);
    };
    for (const d of seed.order_drafts) {
      await client.query(
        `insert into order_drafts (venue_id, membership_id, check_id, lines, updated_at) values ($1, $2, $3, $4, $5)`,
        [
          venueId,
          id(`${d.membership}.membership`),
          tabCheck(d.tab),
          JSON.stringify(
            d.lines.map((l) => ({
              variant_id: id(`menu_${l.item_id}_regular`),
              qty: l.qty,
              option_ids: [],
            })),
          ),
          SEED_NOW.toString(),
        ],
      );
    }
    log(`drafts: ${seed.order_drafts.length}`);

    // Pending approvals (M3-25): the payload is what runs on Approve, the same as the fix panel writes (M3-19).
    // The seed has no time for the request; it reads 10:39 PM, two minutes before "now".
    const asked = new Date(SEED_NOW.epochMilliseconds - 2 * 60 * 1000).toISOString();
    for (const a of seed.approvals) {
      const lineId = lineIds.get(a.target);
      if (lineId === undefined) throw new Error(`seed: approval ${a.id} names no line ${a.target}`);
      const checkId = tabCheck(a.tab);
      await client.query(
        `insert into approvals (id, venue_id, kind, target_kind, target_id, amount_cents, reason, payload, requested_by,
           requested_at, routed_to, status)
         values ($1, $2, $3, 'check', $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          remember(a.id, "approvals"),
          venueId,
          a.line_kind,
          checkId,
          a.amount_cents,
          a.reason,
          JSON.stringify({
            check_id: checkId,
            line_id: lineId,
            kind: a.line_kind,
            made: a.made,
            qty: 1,
            description: a.item,
          }),
          id(a.requested_by),
          a.requested_at ?? asked,
          id(a.routed_to),
          a.status,
        ],
      );
    }
    log(`approvals: ${seed.approvals.length}`);

    // The reason-only totals the brief states must be what the lines add up to (spec 02 and 04).
    for (const r of seed.reason_only_used_tonight) {
      const used = await reasonOnlyUsed(client, venueId, id(r.person), seed.meta.business_date);
      if (used !== r.cents)
        throw new Error(
          `seed: ${r.person}'s reason-only total is ${used}, the brief says ${r.cents}`,
        );
    }

    // Devices, with a heartbeat at "now" for each one the seed says is online.
    const offlineSince = new Date(SEED_NOW.epochMilliseconds - 3 * 60 * 60 * 1000);
    for (const device of seed.devices) {
      const deviceId = remember(device.id, "devices");
      const userId = device.owner === undefined ? null : id(device.owner);
      const network =
        device.kind === "router"
          ? {
              cellular_backup: device.cellular_backup ?? false,
              on_backup_now: device.on_backup_now ?? false,
            }
          : null;
      const roomId = device.room === undefined ? null : id(device.room);
      await client.query(
        `insert into devices (id, venue_id, kind, name, user_id, room_id, host_device_id, cellular)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          deviceId,
          venueId,
          device.kind,
          device.name,
          userId,
          roomId,
          device.host === undefined ? null : id(device.host),
          device.kind === "reader" ? (device.cellular ?? null) : null,
        ],
      );
      if (device.online === true) {
        await client.query(
          `insert into device_heartbeats (device_id, venue_id, last_seen_at, network) values ($1, $2, $3, $4)`,
          [deviceId, venueId, seedNow, network],
        );
      } else if (device.online === false) {
        await client.query(
          `insert into device_heartbeats (device_id, venue_id, last_seen_at, offline_since) values ($1, $2, $3, $3)`,
          [deviceId, venueId, offlineSince],
        );
      }
    }
    log(`devices: ${seed.devices.length}`);

    // The two house drawers (M4-10): each on its receipt printer's kick port, paired to its screen, with an
    // open session of $300.00. The brief gives no opening time; the sessions open as the business date starts.
    const dayStart = Temporal.ZonedDateTime.from(
      `${seed.meta.business_date}T${dayCutover}:00[${seed.venue.time_zone}]`,
    ).toInstant();
    for (const d of seed.drawers ?? []) {
      const drawerId = remember(d.id, "cash_drawers");
      await client.query(
        `insert into cash_drawers (id, venue_id, name, station, printer_device_id) values ($1, $2, $3, $4, $5)`,
        [
          drawerId,
          venueId,
          d.name,
          d.id.includes("bar") ? "bar" : "front_desk",
          id(d.kick_port_of),
        ],
      );
      await client.query("update devices set cash_drawer_id = $3 where venue_id = $1 and id = $2", [
        venueId,
        id(d.screen),
        drawerId,
      ]);
      await client.query(
        `insert into drawer_sessions (id, venue_id, drawer_id, model, responsible_id, state, business_date, opened_at,
           opening_cents)
         values ($1, $2, $3, $4, $5, 'open', $6, $7, $8)`,
        [
          remember(d.session.id, "drawer_sessions"),
          venueId,
          drawerId,
          d.session.model,
          id(d.session.responsible),
          seed.meta.business_date,
          d.session.opened_at ?? dayStart.toString(),
          d.session.opening_cents,
        ],
      );
    }
    log(`drawers: ${(seed.drawers ?? []).length} open at $300.00`);

    // Our own staff for the Console (M1-35): one demo account, signed in locally with a security key.
    await client.query(
      `insert into console_staff (name, email) values ($1, $2)
         on conflict ((lower(email))) do update set name = excluded.name, active = true`,
      ["Noraymi support", "support@demo.west4.local"],
    );
    log("console staff: 1 demo account (support@demo.west4.local)");

    for (const row of seedRows) {
      await client.query(
        `insert into seed_ids (venue_id, slug, entity, row_id) values ($1, $2, $3, $4)
         on conflict (venue_id, slug) do update set entity = excluded.entity, row_id = excluded.row_id, loaded_at = now()`,
        [venueId, row.slug, row.entity, row.id],
      );
    }

    // The simulated clock every process shares: Fri Sep 25, 2026, 10:41 PM, ticking from now.
    await client.query(
      "update clock_control set simulated_at = $1, real_at = now(), set_by = 'seed' where id",
      [seedNow],
    );
    log(`clock: set to ${seed.meta.now}`);

    await client.query("commit");
    return {
      venueId,
      ids,
      counts: {
        memberships: seed.team.length,
        devices: seed.devices.length,
        settings: settings.length,
        modules: modules.length,
        permissionOverrides: overrides.length,
        menuItems: seed.menu.items.length,
      },
    };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

/** The biggest room's capacity, from the seed's rooms (M2 loads the rooms themselves). */
function largestRoom(seed: SeedFile): number {
  const rooms = (seed as unknown as { rooms?: { capacity_max?: number }[] }).rooms ?? [];
  return rooms.reduce((max, r) => Math.max(max, r.capacity_max ?? 0), 1);
}

/** Find a seeded row's UUID by the slug the seed uses (room_9, maya, dev_router). Inside a venue transaction or as the owner. */
export async function seedId(
  client: { query: pg.Client["query"] },
  venueId: string,
  slug: string,
): Promise<string> {
  const r = await client.query<{ id: string }>(
    "select row_id as id from seed_ids where venue_id = $1 and slug = $2",
    [venueId, slug],
  );
  const row = r.rows[0];
  if (!row) throw new Error(`seed_ids: no row for ${slug}`);
  return row.id;
}
