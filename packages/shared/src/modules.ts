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
  | "deposits"
  | "room_tablets"
  | "card_behind_bar"
  | "pay_share"
  | "cash_discount"
  | "outside_card"
  | "check_discount"
  | "bell"
  | "tax_exempt"
  | "inventory"
  | "kitchen_screen"
  | "guest_screen"
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
  /**
   * A module split out of another (D124): a venue with no row of its own reads as that module's
   * row, so a venue made before the split keeps working as it did until its owner sets this one.
   */
  readonly inherits?: ModuleId;
  /**
   * Every plan allows it, off until the owner turns it on, and our Console can't take it away:
   * the outside card machine (D126), the website, Safety & ID records and Marketing texts (D129).
   * One that also `inherits` an always-on module starts on instead: the check discount (P-02).
   */
  readonly allowedOff?: boolean;
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
      texts: [],
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
  // Bar tabs & quick sale: the register, always on (D124's correction). A new bar tab still waits
  // for the go-live merchant category (M4-29), checked where a tab opens.
  { id: "bar_tabs", core: true, phase1: true, needs: [], hides: none },
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
    allowedOff: true,
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
    allowedOff: true,
    needs: [],
    hides: {
      staffApp: ["board.managerNeeded", "board.headcount", "doorCounter", "idScans", "incidentLog"],
      staffPhone: ["incidentLog"],
      website: ["roomPage.helpLink"],
      texts: [],
    },
  },
  // Reports & accounting: always on (D124's correction, "Reports and accounting is a must").
  { id: "reports", core: true, phase1: true, needs: [], hides: none },
  {
    id: "website",
    core: false,
    phase1: true,
    allowedOff: true,
    needs: [],
    hides: {
      staffApp: [],
      staffPhone: [],
      website: ["home", "rooms", "menu", "menuPdf", "parties", "enquiries", "songs"],
      texts: [],
    },
  },
  {
    // Kitchen & food (spec 16 · The Kitchen module; D98): phase 1 for Sing Sing. Guest food follows
    // Ordering from the room, so the room page and tablets lose food with either switch off.
    id: "kitchen",
    core: false,
    phase1: true,
    needs: ["bar_screen"],
    hides: {
      staffApp: ["pos.food", "pos.sendToKitchen", "admin.menu.station", "kitchenTickets"],
      staffPhone: ["runs.food"],
      website: ["roomPage.food", "roomTablets.food", "menu.food", "menuPdf.food", "allergyNotice"],
      texts: [],
    },
  },
  // The switches split out or added by D124. Each inherits the row it came from until it has its own.
  {
    id: "deposits",
    core: false,
    phase1: true,
    needs: ["online_booking"],
    inherits: "online_booking",
    hides: {
      staffApp: ["admin.deposits.online", "paymentLink"],
      staffPhone: [],
      website: ["book.deposit"],
      texts: ["payment_link", "deposit_refund_new"],
    },
  },
  {
    id: "room_tablets",
    core: false,
    phase1: true,
    needs: ["rooms"],
    inherits: "rooms",
    hides: {
      staffApp: ["devices.pairTablet"],
      staffPhone: [],
      website: ["roomTablets"],
      texts: [],
    },
  },
  {
    id: "card_behind_bar",
    core: false,
    phase1: true,
    needs: ["rooms"],
    inherits: "rooms",
    hides: { staffApp: ["checkin.cardBehindBar"], staffPhone: [], website: [], texts: [] },
  },
  {
    id: "pay_share",
    core: false,
    phase1: true,
    needs: ["rooms"],
    inherits: "rooms",
    hides: { staffApp: [], staffPhone: [], website: ["bill.payMyShare"], texts: [] },
  },
  {
    id: "cash_discount",
    core: false,
    phase1: true,
    needs: [],
    inherits: "payments",
    hides: {
      staffApp: ["pos.cashDiscount", "admin.cashDiscount"],
      staffPhone: [],
      website: [],
      texts: [],
    },
  },
  // Paid on an outside card machine (D126): every plan allows it; off until the owner turns it on.
  {
    id: "outside_card",
    core: false,
    phase1: true,
    needs: [],
    allowedOff: true,
    hides: { staffApp: ["pay.outsideCard"], staffPhone: [], website: [], texts: [] },
  },
  // A % or $ discount on a whole check (P-02): every plan allows it, and it's on until the owner
  // turns it off (a venue with no row of its own reads as Payments & checks, always on).
  {
    id: "check_discount",
    core: false,
    phase1: true,
    needs: [],
    inherits: "payments",
    allowedOff: true,
    hides: { staffApp: ["check.discount"], staffPhone: ["check.discount"], website: [], texts: [] },
  },
  // One bell for everything waiting (P-11): in the top bar, every plan, on until the owner turns it
  // off (a venue with no row of its own reads as Admin, always on). The menu badges stay either way.
  {
    id: "bell",
    core: false,
    phase1: true,
    needs: [],
    inherits: "admin",
    allowedOff: true,
    hides: { staffApp: ["bell"], staffPhone: ["bell"], website: [], texts: [] },
  },
  // Tax-exempt sales (P-15; Money rules 8): every plan allows it; off until the owner turns it on,
  // the cautious default while which sales may be exempt is the accountant's question (spec 14).
  {
    id: "tax_exempt",
    core: false,
    phase1: true,
    needs: [],
    allowedOff: true,
    hides: {
      staffApp: ["check.taxExempt"],
      staffPhone: ["check.taxExempt"],
      website: [],
      texts: [],
    },
  },
  // Inventory (P-16): a stock count per menu item or variant, Reports → Stock. Every plan allows it,
  // off until the owner turns it on; it needs Reports & accounting, where its screen lives.
  {
    id: "inventory",
    core: false,
    phase1: true,
    needs: ["reports"],
    allowedOff: true,
    hides: { staffApp: ["reports.stock"], staffPhone: [], website: [], texts: [] },
  },
  // Kitchen screen (P-17; D131): open kitchen tickets on a paired kitchen display or a bar computer's
  // second window, oldest first, bumped with Done. Every plan with the kitchen allows it, off until the
  // owner turns it on; it needs Kitchen & food, whose tickets it shows.
  {
    id: "kitchen_screen",
    core: false,
    phase1: true,
    needs: ["kitchen"],
    allowedOff: true,
    hides: {
      staffApp: ["kitchenScreen", "barOrders.foodUp"],
      staffPhone: [],
      website: [],
      texts: [],
    },
  },
  // Guest screen (P-18): the check being rung up at a register, shown to the guest on a bar
  // computer's second monitor or a paired guest display; idle, the venue's name. Every plan allows
  // it, off until the owner turns it on.
  {
    id: "guest_screen",
    core: false,
    phase1: true,
    needs: [],
    allowedOff: true,
    hides: { staffApp: ["guestScreen", "pos.guestScreen"], staffPhone: [], website: [], texts: [] },
  },
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

/** What Kitchen & food still needs before it can be on (spec 16 · The Kitchen module), besides its modules. */
export type KitchenMissing = "printer" | "allergyNotice";

export function kitchenMissing(ready: {
  readonly kitchenPrinter: boolean;
  readonly allergyNotice: boolean;
}): KitchenMissing[] {
  const out: KitchenMissing[] = [];
  if (!ready.kitchenPrinter) out.push("printer");
  if (!ready.allergyNotice) out.push("allergyNotice");
  return out;
}

/**
 * What each plan includes (O-04; spec 17 · Step details 2; D114, D121), besides
 * the core modules, which every venue has (bar tabs and reports among them
 * since D124), from the blueprint's plan table: Bar is bar mode, the bar
 * screen, team and tip pool, guest texts and the cash discount. Choosing a plan allows these and switches them on (D121); the
 * owner turns any of them off in Admin → Features. The website, Safety & ID
 * records, Marketing texts and the outside card machine are in every plan
 * (`allowedOff`, D129): allowed everywhere and off until the owner turns them on.
 */
const BAR_PLAN_MODULES: readonly ModuleId[] = [
  "bar_mode",
  "bar_screen",
  "team",
  "guest_texts",
  "cash_discount",
];
const ROOMS_PLAN_MODULES: readonly ModuleId[] = [
  ...BAR_PLAN_MODULES,
  "rooms",
  "online_booking",
  "room_ordering",
  "packages",
  "song_system",
  "waitlist",
  "deposits",
  "room_tablets",
  "card_behind_bar",
  "pay_share",
];
export type PlanKey = "bar" | "rooms" | "rooms_kitchen";
export const PLAN_MODULES: Readonly<Record<PlanKey, readonly ModuleId[]>> = {
  bar: BAR_PLAN_MODULES,
  rooms: ROOMS_PLAN_MODULES,
  rooms_kitchen: [...ROOMS_PLAN_MODULES, "kitchen"],
};
/** Every module some plan decides. */
export const PLAN_GOVERNED_MODULES: readonly ModuleId[] = PLAN_MODULES.rooms_kitchen;

/**
 * What choosing `plan` switches on (D121): the modules it includes that the
 * venue's previous plan (`from`, null for a first plan) didn't, in the table's
 * order, so each comes after what it needs. The same plan again switches on
 * nothing, so a module the owner turned off stays off.
 */
export function planSwitchesOn(plan: PlanKey, from: PlanKey | null): ModuleId[] {
  const before = from ? PLAN_MODULES[from] : [];
  const todo = PLAN_MODULES[plan].filter((id) => !before.includes(id));
  const out: ModuleId[] = [];
  const visit = (id: ModuleId): void => {
    if (out.includes(id)) return;
    for (const need of moduleDef(id).needs) if (todo.includes(need)) visit(need);
    out.push(id);
  };
  for (const id of todo) visit(id);
  return out;
}
