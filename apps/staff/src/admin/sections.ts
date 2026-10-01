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
    shipped: false,
  },
  {
    id: "payments",
    path: "/admin/payments",
    labelKey: "admin.section.payments",
    hintKey: "admin.hint.payments",
    action: "admin.payments",
    shipped: false,
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
