import {
  inMenuOrder,
  moduleDef,
  moduleIds,
  stateOf,
  type Action,
  type MessageKey,
  type ModuleStates,
  type Role,
} from "@west4/shared";

/**
 * The side menu (spec 10 · rule 1): the same on every desktop screen, built
 * from the modules that are on and what the signed-in role may do. An entry
 * appears when its screen ships; until then it's listed here with
 * shipped: false so the order and the rules are settled from the start.
 */
export interface MenuEntry {
  readonly id: string;
  readonly labelKey: MessageKey;
  readonly path: string;
  /** The screen id a module hides when it's off (modules.ts hides.staffApp). */
  readonly screen: string;
  /** The role action the entry needs, checked against the person's permissions. */
  readonly action?: Action;
  readonly shipped: boolean;
}

export const menu: readonly MenuEntry[] = [
  { id: "tonight", labelKey: "menu.rooms", path: "/tonight", screen: "board", shipped: true },
  {
    id: "barPos",
    labelKey: "menu.barPos",
    path: "/bar",
    screen: "pos",
    action: "pos.use",
    shipped: true,
  },
  {
    id: "barOrders",
    labelKey: "menu.barOrders",
    path: "/bar-orders",
    screen: "barOrders",
    action: "orders.accept",
    shipped: true,
  },
  {
    id: "songQueue",
    labelKey: "menu.songQueue",
    path: "/song-queue",
    screen: "songQueue",
    action: "pos.use",
    shipped: true,
  },
  {
    id: "calendar",
    labelKey: "menu.calendar",
    path: "/calendar",
    screen: "calendar",
    action: "bookings.manage",
    shipped: true,
  },
  {
    id: "messages",
    labelKey: "menu.messages",
    path: "/messages",
    screen: "messages",
    action: "texts.send",
    shipped: true,
  },
  // Tips to enter and Clock in and out (D126): the phone's tabs on the desktop too, so a venue on its
  // bar computers alone needs no staff phone.
  {
    id: "tips",
    labelKey: "tips.title",
    path: "/tips",
    screen: "tipsToEnter",
    action: "pos.use",
    shipped: true,
  },
  { id: "clock", labelKey: "tabs.clock", path: "/clock", screen: "timeClock", shipped: true },
  {
    id: "reports",
    labelKey: "menu.reports",
    path: "/reports",
    screen: "reports",
    action: "reports.view",
    shipped: true,
  },
  {
    id: "closeNight",
    labelKey: "menu.closeNight",
    path: "/close-the-night",
    screen: "closeTheNight",
    action: "night.close",
    shipped: true,
  },
  // The incident log (D126), for owners and managers, while Safety & ID records is on.
  {
    id: "incidents",
    labelKey: "tabs.incidents",
    path: "/incidents",
    screen: "incidentLog",
    action: "night.close",
    shipped: true,
  },
  {
    id: "admin",
    labelKey: "menu.admin",
    path: "/admin",
    screen: "admin",
    action: "admin.access",
    shipped: true,
  },
  { id: "lock", labelKey: "menu.lock", path: "/lock", screen: "lock", shipped: true },
];

/** The runner's phone home: not a side-menu entry, but a screen the shell routes to. */
export const runs: MenuEntry = {
  id: "runs",
  labelKey: "menu.runs",
  path: "/runs",
  screen: "runs",
  shipped: true,
};

/** Screen ids hidden because a module that hides them is off (stopping still shows). */
export function hiddenScreens(modules: ModuleStates): ReadonlySet<string> {
  const hidden = new Set<string>();
  for (const id of moduleIds) {
    if (stateOf(modules, id) === "off") for (const s of moduleDef(id).hides.staffApp) hidden.add(s);
  }
  return hidden;
}

export interface MenuContext {
  readonly modules: ModuleStates;
  readonly permissions: readonly Action[];
  /** Can also open (P-10): Admin sections the owner gave this person; any of them shows Admin. */
  readonly adminSections?: readonly string[];
  /** Tests look at entries whose screens haven't shipped yet. */
  readonly includeUnshipped?: boolean;
}

/** The person may do this action, or (for Admin) opens a section the owner gave them (P-10). */
function mayOpen(context: MenuContext, action: Action): boolean {
  return (
    context.permissions.includes(action) ||
    (action === "admin.access" && (context.adminSections ?? []).length > 0)
  );
}

export function visibleMenu(
  context: MenuContext,
  entries: readonly MenuEntry[] = menu,
): MenuEntry[] {
  const hidden = hiddenScreens(context.modules);
  return entries.filter(
    (e) =>
      (e.shipped || context.includeUnshipped === true) &&
      !hidden.has(e.screen) &&
      (e.action === undefined || mayOpen(context, e.action)),
  );
}

/** One home per role (spec 10 · rule 1). */
export function homeFor(role: Role): string {
  switch (role) {
    case "bartender":
      return "/bar";
    case "staff":
      return "/runs";
    default:
      return "/tonight";
  }
}

/**
 * A phone opens the portal of the person who signed in, with that role's
 * tabs only (Pin note 4). U-19 (D133): at most five bottom tabs, the role's
 * home first, then its most used, then **More**, which opens the ☰ list of
 * everything else; nothing shows in both.
 */
export interface PhoneTab {
  readonly id: string;
  readonly labelKey: MessageKey;
  readonly path: string;
}

/** Every screen this person's phone may open, in the app's order (modules and permissions applied). */
export function phoneDestinations(context: MenuContext & { role: Role }): PhoneTab[] {
  const can = (a: Action) => context.permissions.includes(a);
  const tabs: PhoneTab[] = [];
  // The role's own home first: Runs for runners, the bar POS for bartenders (M3 and M1).
  if (context.role === "staff") tabs.push({ id: "home", labelKey: runs.labelKey, path: runs.path });
  if (context.role === "bartender")
    tabs.push({ id: "home", labelKey: menu[1]!.labelKey, path: menu[1]!.path });
  // Tonight's bookings and check-in, for everyone who checks guests in (runners too). It's
  // "Bookings" (D111): "Rooms" is the board, and the phone has one tab of each.
  if (can("guests.checkin"))
    tabs.push({ id: "tonight", labelKey: "tabs.bookings", path: "/today" });
  if (context.role !== "staff")
    tabs.push({ id: "rooms", labelKey: "tabs.rooms", path: "/tonight" });
  tabs.push({ id: "calls", labelKey: "tabs.calls", path: "/calls" });
  if (can("waitlist.manage") && context.modules.waitlist !== "off")
    tabs.push({ id: "waitlist", labelKey: "waitlist.title", path: "/waitlist" });
  if (can("texts.send") && context.modules.guest_texts !== "off")
    tabs.push({ id: "messages", labelKey: "menu.messages", path: "/messages" });
  if (can("approvals.decide"))
    tabs.push({ id: "approvals", labelKey: "menu.approvals", path: "/approvals" });
  // Incidents (M8-08; Staff note 19): the help alert and the incident log, on managers' and owners'
  // phones only, while Safety & ID records is on.
  if ((context.role === "owner" || context.role === "manager") && context.modules.safety !== "off")
    tabs.push({ id: "incidents", labelKey: "tabs.incidents", path: "/incidents" });
  // Tips to enter (M6-09; screens N26): the signed paper slips waiting for their tips.
  if (can("pos.use") && context.modules.bar_tabs !== "off")
    tabs.push({ id: "tips", labelKey: "tips.title", path: "/tips" });
  // Clock in and out (M7-01; screens N24), while Team, time clock & tips is on.
  if (context.modules.team !== "off")
    tabs.push({ id: "clock", labelKey: "tabs.clock", path: "/clock" });
  // My tips (M7-10), under Team, time clock & tips, for the people who share in tips (U-19:
  // `tips.share`, no longer everyone).
  if (can("tips.share") && context.modules.team !== "off")
    tabs.push({ id: "mytips", labelKey: "tabs.myTips", path: "/my-tips" });
  // Reports (M7-18), for owners and managers while Reports & accounting is on.
  if (can("reports.view") && context.modules.reports !== "off")
    tabs.push({ id: "reports", labelKey: "tabs.reports", path: "/reports" });
  // Offline codes (M8-04): managers' and owners' phones only keep each computer's codes.
  if (context.role === "owner" || context.role === "manager")
    tabs.push({ id: "offlineCodes", labelKey: "offlineCodes.title", path: "/offline-codes" });
  // Alerts on this phone (push and sound): always under More, so it takes its full name.
  tabs.push({ id: "alerts", labelKey: "setup.title", path: "/setup" });
  if (mayOpen(context, "admin.access"))
    tabs.push({ id: "admin", labelKey: "menu.admin", path: "/admin" });
  return tabs;
}

/** The most bottom tabs a phone shows before More (U-19): five in all with More. */
export const phoneTabLimit = 4;

/**
 * Which bottom tabs each role gets (U-19, D133; spec 10 · rule 1, phone), in order: the first
 * four this person can open become tabs and More is the fifth; everything else is under More.
 * The stand-ins take a place only when a switched-off feature or a permission removes one before.
 *
 * | Role       | Tabs, then More                         | Stand-ins              |
 * | ---------- | --------------------------------------- | ---------------------- |
 * | Bartender  | Bar POS, Rooms, Calls, Messages         | Tips to enter, Clock   |
 * | Front desk | Rooms, Bookings, Calls, Messages        | Waitlist, Clock        |
 * | Runner     | Runs, Bookings, Calls, Waitlist         | Clock, My tips         |
 * | Manager    | Rooms, Approvals, Calls, Messages       | Bookings, Incidents    |
 * | Owner      | Rooms, Approvals, Reports, Calls        | Messages, Bookings     |
 */
export const phoneTabsByRole: Readonly<Record<Role, readonly string[]>> = {
  bartender: ["home", "rooms", "calls", "messages", "tips", "clock"],
  front_desk: ["rooms", "tonight", "calls", "messages", "waitlist", "clock"],
  staff: ["home", "tonight", "calls", "waitlist", "clock", "mytips"],
  manager: ["rooms", "approvals", "calls", "messages", "tonight", "incidents"],
  owner: ["rooms", "approvals", "reports", "calls", "messages", "tonight"],
};

/** The phone's bottom tabs before More (U-19): at most four, from the role's row of the table. */
export function phoneTabs(context: MenuContext & { role: Role }): PhoneTab[] {
  const open = phoneDestinations(context);
  const tabs: PhoneTab[] = [];
  for (const id of phoneTabsByRole[context.role] ?? []) {
    const tab = open.find((t) => t.id === id);
    if (tab && tabs.length < phoneTabLimit) tabs.push(tab);
  }
  return tabs;
}

/**
 * More (U-19): the ☰ list on a phone, holding only what isn't a bottom tab. The side menu's
 * entries in the venue's order (P-13) come first, then the phone's own screens (Bookings, Calls,
 * Waitlist, Approvals and the rest), and Lock last. A screen is matched by its path, so the bar
 * POS (the bartender's home) and the board (Rooms) never show twice.
 */
export function phoneMore(
  context: MenuContext & { role: Role; menuOrder?: readonly string[] | null | undefined },
): PhoneTab[] {
  const tabPaths = new Set(phoneTabs(context).map((t) => t.path));
  const entries = inMenuOrder(visibleMenu(context), context.menuOrder);
  const menuPaths = new Set(entries.map((e) => e.path));
  const item = (e: PhoneTab): PhoneTab => ({ id: e.id, labelKey: e.labelKey, path: e.path });
  const fromMenu = entries.filter((e) => e.id !== "lock" && !tabPaths.has(e.path)).map(item);
  const own = phoneDestinations(context).filter(
    (d) => !tabPaths.has(d.path) && !menuPaths.has(d.path),
  );
  const lock = entries.filter((e) => e.id === "lock").map(item);
  return [...fromMenu, ...own, ...lock];
}
