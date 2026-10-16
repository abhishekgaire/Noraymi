import type { MessageKey, ModuleId } from "@west4/shared";

/**
 * Admin's groups (U-21; D133; spec 03 · Admin's groups): the one table that puts every Admin
 * section and every Features switch under one of six headings, so an owner reads six short
 * groups instead of one long list. Grouping only places things: who sees a section (role,
 * owner-only, Can also open) and what a switch does (refused on the server while off) don't
 * change. The headings show in this order; a group with nothing in it isn't shown.
 */
export const ADMIN_GROUPS = ["rooms", "bar", "guests", "team", "money", "venue"] as const;
export type AdminGroup = (typeof ADMIN_GROUPS)[number];

const GROUP_LABEL: Readonly<Record<AdminGroup, MessageKey>> = {
  rooms: "admin.group.rooms",
  bar: "admin.group.bar",
  guests: "admin.group.guests",
  team: "admin.group.team",
  money: "admin.group.money",
  venue: "admin.group.venue",
};

export const groupLabelKey = (g: AdminGroup): MessageKey => GROUP_LABEL[g];

/** Every Admin section's group, by section id (sections.ts). A test checks none is missing. */
export const SECTION_GROUP: Readonly<Record<string, AdminGroup>> = {
  rooms: "rooms",
  hours: "rooms",
  alerts: "rooms",
  barPos: "bar",
  barMode: "bar",
  menu: "bar",
  kitchen: "bar",
  deposits: "guests",
  phone: "guests",
  texts: "guests",
  website: "guests",
  publicForms: "guests",
  team: "team",
  activity: "team",
  console: "team",
  payments: "money",
  cardFee: "money",
  disputes: "money",
  cashDrawers: "money",
  setup: "venue",
  venue: "venue",
  features: "venue",
  devices: "venue",
  connections: "venue",
  licenses: "venue",
  safety: "venue",
  about: "venue",
};

/** Every module's group in Admin → Features (and Set up your venue's Choose your features). */
export const MODULE_GROUP: Readonly<Record<ModuleId, AdminGroup>> = {
  rooms: "rooms",
  room_ordering: "rooms",
  room_tablets: "rooms",
  song_system: "rooms",
  packages: "rooms",
  event_sales: "rooms",
  bar_tabs: "bar",
  bar_screen: "bar",
  bar_mode: "bar",
  kitchen: "bar",
  inventory: "bar",
  alcohol: "bar",
  website: "guests",
  online_booking: "guests",
  waitlist: "guests",
  deposits: "guests",
  guest_texts: "guests",
  marketing_texts: "guests",
  guests_loyalty: "guests",
  team: "team",
  bell: "team",
  payments: "money",
  reports: "money",
  card_behind_bar: "money",
  pay_share: "money",
  cash_discount: "money",
  outside_card: "money",
  check_discount: "money",
  tax_exempt: "money",
  admin: "venue",
  devices: "venue",
  safety: "venue",
  multi_location: "venue",
};

/** Splits a list into the six groups in their order, keeping each item's own order; empty groups drop out. */
export function byGroup<T>(
  items: readonly T[],
  groupOf: (item: T) => AdminGroup,
): { group: AdminGroup; items: T[] }[] {
  return ADMIN_GROUPS.map((group) => ({
    group,
    items: items.filter((i) => groupOf(i) === group),
  })).filter((g) => g.items.length > 0);
}

/** A section id the table doesn't name falls under Venue rather than vanishing. */
export const sectionGroup = (id: string): AdminGroup => SECTION_GROUP[id] ?? "venue";
