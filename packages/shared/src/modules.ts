/**
 * Modules (spec 03 · Modules, What each module hides; M1-13). The switchable
 * modules a venue turns on, stops or turns off, what each needs, and what
 * each hides. Every screen, the website and the text sender read this one
 * table, so a module that's off disappears everywhere at once. Names live in
 * the i18n catalog under module.<id>.name.
 */
export type ModuleId =
  | "website"
  | "online_booking"
  | "waitlist"
  | "rooms"
  | "room_ordering"
  | "bar_screen"
  | "bar_tabs"
  | "bar_mode"
  | "packages"
  | "song_system"
  | "guest_texts"
  | "marketing_texts"
  | "team"
  | "safety"
  | "reports"
  | "kitchen"
  | "event_sales"
  | "guests_loyalty"
  | "multi_location"
  | "payments"
  | "alcohol"
  | "admin"
  | "devices";

export type ModuleState = "on" | "stopping" | "off";

export interface ModuleEffects {
  /** Staff app, desktop and bar POS: screen ids that disappear. */
  readonly staffApp: readonly string[];
  /** Staff phone tabs that disappear. */
  readonly staffPhone: readonly string[];
  /** Website sections and room-page parts that disappear. */
  readonly website: readonly string[];
  /** Texts that stop going out. */
  readonly texts: readonly string[];
}

export interface ModuleDef {
  readonly id: ModuleId;
  /** Always on; can't be turned off. */
  readonly core: boolean;
  /** A phase 1 screen shows it. Phase 2 modules exist as rows only. */
  readonly phase1: boolean;
  readonly needs: readonly ModuleId[];
  readonly hides: ModuleEffects;
}

const none: ModuleEffects = { staffApp: [], staffPhone: [], website: [], texts: [] };

export const modules: readonly ModuleDef[] = [
  { id: "payments", core: true, phase1: true, needs: [], hides: none },
  { id: "alcohol", core: true, phase1: true, needs: [], hides: none },
  { id: "admin", core: true, phase1: true, needs: [], hides: none },
  { id: "devices", core: true, phase1: true, needs: [], hides: none },
  {
    id: "rooms",
    core: false,
    phase1: true,
    needs: [],
    hides: {
      staffApp: ["board", "deskroom", "calendar", "pos.roomsList"],
      staffPhone: ["tonight", "rooms", "calendar"],
      website: ["rooms", "roomTablets"],
      texts: [
        "booking_confirmed",
        "reminder",
        "room_code",
        "please_wrap_up",
        "booked_time_ending",
        "running_late_reply",
      ],
    },
  },
  {
    id: "online_booking",
    core: false,
    phase1: true,
    needs: ["rooms"],
    hides: {
      staffApp: ["admin.deposits"],
      staffPhone: [],
      website: ["book", "manage.newBookings", "hero.bookARoom"],
      texts: ["payment_link", "deposit_refund_new"],
    },
  },
  {
    id: "waitlist",
    core: false,
    phase1: true,
    needs: [],
    hides: {
      staffApp: ["board.waitlistDrawer"],
      staffPhone: ["waitlist"],
      website: ["doorQr", "waitlist"],
      texts: ["room_ready", "offer_expiring"],
    },
  },
  {
    id: "room_ordering",
    core: false,
    phase1: true,
    needs: ["rooms", "bar_screen"],
    hides: {
      staffApp: [],
      staffPhone: [],
      website: ["roomPage.menu", "roomPage.ordering", "roomPage.sameAgain", "roomTablets.ordering"],
      texts: [],
    },
  },
  {
    id: "bar_screen",
    core: false,
    phase1: true,
    needs: [],
    hides: {
      staffApp: ["barOrders", "pos.roomOrderCards", "tickets"],
      staffPhone: ["runs"],
      website: [],
      texts: [],
    },
  },
  {
    id: "bar_tabs",
    core: false,
    phase1: true,
    needs: [],
    hides: {
      staffApp: ["pos.newTab", "pos.barTabs", "pos.quickSale"],
      staffPhone: ["tipsToEnter"],
      website: [],
      texts: [],
    },
  },
  {
    id: "bar_mode",
    core: false,
    phase1: true,
    needs: ["bar_tabs"],
    hides: {
      staffApp: ["songQueue", "pos.songQueueCount", "upNextTv"],
      staffPhone: [],
      website: ["singAtTheBar", "singerQueuePage"],
      texts: ["youre_up_next"],
    },
  },
  {
    id: "packages",
    core: false,
    phase1: true,
    needs: ["rooms"],
    hides: {
      staffApp: ["menus.packages"],
      staffPhone: [],
      website: ["menu.packages", "menu.happyHour", "menuPdf.packages"],
      texts: [],
    },
  },
  {
    id: "song_system",
    core: false,
    phase1: true,
    needs: ["rooms"],
    hides: { staffApp: ["admin.songSystem"], staffPhone: [], website: [], texts: [] },
  },
  {
    id: "guest_texts",
    core: false,
    phase1: true,
    needs: [],
    hides: {
      staffApp: ["messages", "textButtons"],
      staffPhone: ["messages"],
      website: [],
      texts: ["all_service_texts"],
    },
  },
  {
    id: "marketing_texts",
    core: false,
    phase1: true,
    needs: ["guest_texts"],
    hides: {
      staffApp: [],
      staffPhone: [],
      website: ["booking.marketingOptIn"],
      texts: ["review_ask", "birthday"],
    },
  },
  {
    id: "team",
    core: false,
    phase1: true,
    needs: [],
    hides: {
      staffApp: ["timeClock", "closeTheNight.tipPool"],
      staffPhone: ["clockInOut", "myTips"],
      website: [],
      texts: [],
    },
  },
  {
    id: "safety",
    core: false,
    phase1: true,
    needs: [],
    hides: {
      staffApp: ["board.managerNeeded", "board.headcount", "doorCounter", "idScans"],
      staffPhone: ["incidentLog"],
      website: ["roomPage.helpLink"],
      texts: [],
    },
  },
  {
    id: "reports",
    core: false,
    phase1: true,
    needs: [],
    hides: { staffApp: ["reports", "exports"], staffPhone: ["reports"], website: [], texts: [] },
  },
  {
    id: "website",
    core: false,
    phase1: true,
    needs: [],
    hides: {
      staffApp: [],
      staffPhone: [],
      website: ["home", "rooms", "menu", "menuPdf", "parties", "enquiries", "songs"],
      texts: [],
    },
  },
  { id: "kitchen", core: false, phase1: false, needs: [], hides: none },
  { id: "event_sales", core: false, phase1: false, needs: ["rooms"], hides: none },
  { id: "guests_loyalty", core: false, phase1: false, needs: [], hides: none },
  { id: "multi_location", core: false, phase1: false, needs: [], hides: none },
];

export const moduleIds: readonly ModuleId[] = modules.map((m) => m.id);
const byId = new Map(modules.map((m) => [m.id, m]));

export function moduleDef(id: ModuleId): ModuleDef {
  const def = byId.get(id);
  if (!def) throw new Error(`no module ${id}`);
  return def;
}

export function isModuleId(id: string): id is ModuleId {
  return byId.has(id as ModuleId);
}

export type ModuleStates = Readonly<Partial<Record<ModuleId, ModuleState>>>;

export function stateOf(states: ModuleStates, id: ModuleId): ModuleState {
  return moduleDef(id).core ? "on" : (states[id] ?? "off");
}

/** Modules that directly or indirectly need `id` and are on (or stopping): what turns off with it. */
export function turnsOffWith(states: ModuleStates, id: ModuleId): ModuleId[] {
  const out: ModuleId[] = [];
  const visit = (target: ModuleId): void => {
    for (const m of modules) {
      if (m.needs.includes(target) && stateOf(states, m.id) !== "off" && !out.includes(m.id)) {
        out.push(m.id);
        visit(m.id);
      }
    }
  };
  visit(id);
  // In the order spec 03 lists the modules.
  return moduleIds.filter((m) => out.includes(m));
}

/** What a module still needs before it can be on. */
export function missingNeeds(states: ModuleStates, id: ModuleId): ModuleId[] {
  return moduleDef(id).needs.filter((need) => stateOf(states, need) !== "on");
}

/** The confirm that turning off Bar screen & tickets needs while Ordering from the room is on. */
export const ROOM_ORDERS_NOWHERE_TO_RING = {
  turningOff: "bar_screen",
  whileOn: "room_ordering",
} as const;

export function needsRoomOrdersConfirm(states: ModuleStates, id: ModuleId): boolean {
  return (
    id === ROOM_ORDERS_NOWHERE_TO_RING.turningOff &&
    stateOf(states, ROOM_ORDERS_NOWHERE_TO_RING.whileOn) !== "off"
  );
}
