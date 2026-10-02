import type { Action, MessageKey } from "@west4/shared";

/**
 * The AdminDesk sections (M1-31; screens.md · AdminDesk; milestones.md ·
 * Admin by milestone). One list in the spec's order; each ticket flips its
 * section to shipped. Team, Payments and Console are the owner's: their
 * actions default to the owner alone in the permission table, so a manager's
 * Admin never lists them, and the API refuses them to a manager as well.
 */
export interface AdminSection {
  readonly id: string;
  readonly path: string;
  readonly labelKey: MessageKey;
  readonly hintKey: MessageKey;
  /** The role action the section needs (owner-only sections carry their own). */
  readonly action: Action;
  readonly shipped: boolean;
}

export const adminSections: readonly AdminSection[] = [
  {
    id: "team",
    path: "/admin/team",
    labelKey: "team.title",
    hintKey: "admin.hint.team",
    action: "admin.team",
    shipped: true,
  },
  {
    id: "features",
    path: "/admin/features",
    labelKey: "admin.section.features",
    hintKey: "admin.hint.features",
    action: "admin.access",
    shipped: true,
  },
  {
    id: "hours",
    path: "/admin/hours",
    labelKey: "admin.section.hours",
    hintKey: "admin.hint.hours",
    action: "admin.access",
    shipped: true,
  },
  {
    id: "devices",
    path: "/admin/devices",
    labelKey: "admin.section.devices",
    hintKey: "admin.hint.devices",
    action: "admin.access",
    shipped: true,
  },
  {
    id: "rooms",
    path: "/admin/rooms",
    labelKey: "admin.section.rooms",
    hintKey: "admin.hint.rooms",
    action: "admin.access",
    shipped: true,
  },
  {
    id: "menu",
    path: "/admin/menu",
    labelKey: "admin.section.menu",
    hintKey: "admin.hint.menu",
    action: "admin.access",
    shipped: true,
  },
  {
    id: "phone",
    path: "/admin/phone",
    labelKey: "admin.section.phone",
    hintKey: "admin.hint.phone",
    action: "admin.access",
    shipped: true,
  },
  {
    id: "texts",
    path: "/admin/texts",
    labelKey: "admin.section.texts",
    hintKey: "admin.hint.texts",
    action: "admin.access",
    shipped: true,
  },
  {
    id: "alerts",
    path: "/admin/alerts",
    labelKey: "admin.section.alerts",
    hintKey: "admin.hint.alerts",
    action: "admin.access",
    shipped: true,
  },
  {
    id: "safety",
    path: "/admin/safety",
    labelKey: "admin.section.safety",
    hintKey: "admin.hint.safety",
    action: "admin.access",
    shipped: true,
  },
  {
    id: "connections",
    path: "/admin/connections",
    labelKey: "admin.section.connections",
    hintKey: "admin.hint.connections",
    action: "admin.access",
    shipped: true,
  },
  {
    id: "payments",
    path: "/admin/payments",
    labelKey: "admin.section.payments",
    hintKey: "admin.hint.payments",
    action: "admin.payments",
    shipped: true,
  },
  {
    id: "disputes",
    path: "/admin/disputes",
    labelKey: "admin.section.disputes",
    hintKey: "admin.hint.disputes",
    action: "admin.access",
    shipped: true,
  },
  {
    id: "console",
    path: "/admin/console",
    labelKey: "admin.section.console",
    hintKey: "admin.hint.console",
    action: "admin.console",
    shipped: false,
  },
];

export function visibleSections(
  permissions: readonly Action[],
  options: { includeUnshipped?: boolean } = {},
  sections: readonly AdminSection[] = adminSections,
): AdminSection[] {
  return sections.filter(
    (s) => (s.shipped || options.includeUnshipped === true) && permissions.includes(s.action),
  );
}
