import { createHash } from "node:crypto";
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
} from "@west4/shared";
import type { DeviceKind } from "./devices.js";

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
export interface SeedFile {
  readonly meta: { readonly now: string; readonly business_date: string };
  readonly venue: {
    readonly id: string;
    readonly name: string;
    readonly address: string;
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
  readonly bookings: readonly SeedBooking[];
  readonly sessions: readonly SeedSession[];
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
}

export interface SeedRoom {
  readonly id: string;
  readonly name: string;
  readonly size_tier: string;
  readonly capacity_min: number;
  readonly capacity_max: number;
  readonly is_vip: boolean;
  readonly state: "available" | "in_use" | "wrap_up" | "cleaning" | "out_of_service";
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
  readonly status: string;
}

export interface SeedSession {
  readonly id: string;
  readonly room: string;
  readonly booking: string | null;
  readonly started_at: string;
  readonly party_size: number;
}

export interface SeedDevice {
  readonly id: string;
  readonly kind: DeviceKind;
  readonly name: string;
  readonly room?: string;
  readonly owner?: string;
  readonly online?: boolean;
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
  drawerSecondCounter: "never",
  drawerPaidOutApprovalCents: 2500,
  roomsCleaningMin: 0,
  messagesReminderAt: "14:00",
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
      vip: prices["vip"] ?? null,
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
    messages: { reminderAt: SEED_SETTING_DEFAULTS.messagesReminderAt, offerExpiringMin: 5 },
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
  };
}

/** Load the M1 part of the demo seed. Wipes the venue's M1 rows first, so a second load gives the same rows and ids. */
export async function loadDemoSeed(options: SeedLoadOptions): Promise<SeedLoadResult> {
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

    // The organization and the venue. The seed has no legal name; the venue's name stands in (Notes).
    const orgId = remember("org_west4", "organizations");
    await client.query(
      `insert into organizations (id, legal_name) values ($1, $2)
       on conflict (id) do update set legal_name = excluded.legal_name`,
      [orgId, seed.venue.name],
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
        JSON.stringify({ line1, city, state }),
        seed.venue.time_zone,
        dayCutover,
        seed.venue.rule_pack_id,
      ],
    );

    // A fresh Friday: everything this load owns goes first, children before parents.
    await client.query("delete from push_subscriptions where venue_id = $1", [venueId]);
    await client.query(
      "delete from device_nonces where device_id in (select id from devices where venue_id = $1)",
      [venueId],
    );
    for (const table of [
      "pin_lockouts",
      "staff_badges",
      "invites",
      "phone_codes",
      "device_pairing_codes",
      "device_heartbeats",
      "devices",
      "room_blocks",
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
        `insert into users (id, name, email) values ($1, $2, $3)
         on conflict (id) do update set name = excluded.name, email = excluded.email`,
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
      const since =
        room.state === "out_of_service" && room.fault?.reported_on
          ? new Date(`${room.fault.reported_on}T12:00:00-04:00`)
          : seedNow;
      await client.query(
        `insert into room_states (venue_id, room_id, state, reason, since) values ($1, $2, $3, $4, $5)`,
        [venueId, roomId, room.state, reason, since],
      );
    }
    log(`rooms: ${seed.rooms.length}`);

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
        remember(b.id, "bookings"),
      );
      blocks++;
    }
    for (const sess of seed.sessions) {
      const booking = seed.bookings.find((b) => b.id === sess.booking);
      const start = Temporal.Instant.from(sess.started_at);
      let end = booking ? Temporal.Instant.from(booking.ends_at) : start.add({ minutes: 60 });
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
        // Cleaning lasts until staff mark the room clean, and at the latest to the night's 6:00 AM cutover.
        await block(
          room.id,
          "cleaning",
          since,
          Temporal.Instant.from("2026-09-26T06:00:00-04:00"),
          null,
        );
        blocks++;
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
        `insert into devices (id, venue_id, kind, name, user_id, room_id) values ($1, $2, $3, $4, $5, $6)`,
        [deviceId, venueId, device.kind, device.name, userId, roomId],
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
