import {
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
  { id: "tonight", labelKey: "menu.tonight", path: "/tonight", screen: "board", shipped: true },
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
    shipped: false,
  },
  {
    id: "songQueue",
    labelKey: "menu.songQueue",
    path: "/song-queue",
    screen: "songQueue",
    shipped: false,
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
  {
    id: "reports",
    labelKey: "menu.reports",
    path: "/reports",
    screen: "reports",
    action: "reports.view",
    shipped: false,
  },
  {
    id: "closeNight",
    labelKey: "menu.closeNight",
    path: "/close-the-night",
    screen: "closeTheNight",
    action: "night.close",
    shipped: false,
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
  /** Tests look at entries whose screens haven't shipped yet. */
  readonly includeUnshipped?: boolean;
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
      (e.action === undefined || context.permissions.includes(e.action)),
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
 * tabs only (Pin note 4): the role's home, Alerts on this phone, and Admin's
 * stub for owners and managers. Later milestones add the phone tabs modules
 * hide (runs, messages, my tips, clock in and out).
 */
export interface PhoneTab {
  readonly id: string;
  readonly labelKey: MessageKey;
  readonly path: string;
}

export function phoneTabs(context: MenuContext & { role: Role }): PhoneTab[] {
  const can = (a: Action) => context.permissions.includes(a);
  const tabs: PhoneTab[] = [];
  // The role's own home first: Runs for runners, the bar POS for bartenders (M3 and M1).
  if (context.role === "staff") tabs.push({ id: "home", labelKey: runs.labelKey, path: runs.path });
  if (context.role === "bartender")
    tabs.push({ id: "home", labelKey: menu[1]!.labelKey, path: menu[1]!.path });
  // Tonight's bookings and check-in, for everyone who checks guests in (runners too).
  if (can("guests.checkin")) tabs.push({ id: "tonight", labelKey: "tabs.tonight", path: "/today" });
  if (context.role !== "staff")
    tabs.push({ id: "rooms", labelKey: "tabs.rooms", path: "/tonight" });
  tabs.push({ id: "calls", labelKey: "tabs.calls", path: "/calls" });
  if (can("waitlist.manage") && context.modules.waitlist !== "off")
    tabs.push({ id: "waitlist", labelKey: "waitlist.title", path: "/waitlist" });
  if (can("texts.send") && context.modules.guest_texts !== "off")
    tabs.push({ id: "messages", labelKey: "menu.messages", path: "/messages" });
  if (can("approvals.decide"))
    tabs.push({ id: "approvals", labelKey: "menu.approvals", path: "/approvals" });
  tabs.push({ id: "alerts", labelKey: "tabs.alerts", path: "/setup" });
  if (can("admin.access")) tabs.push({ id: "admin", labelKey: "menu.admin", path: "/admin" });
  return tabs;
}
