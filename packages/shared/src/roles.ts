/**
 * Roles and the default permission table (spec 02 · Roles; glossary · Roles;
 * M1-14). One list everywhere. A venue's changes live in role_permissions;
 * the API checks the caller's role before every write, never only the
 * screens. Names live in the i18n catalog under role.<id> and permission.<action>.
 */
export const roles = ["owner", "manager", "bartender", "front_desk", "staff"] as const;
export type Role = (typeof roles)[number];

export const actions = [
  "payments.take", //   Take payments (card and cash), room close-out
  "pos.use", //         Bar POS: quick sale and bar tabs
  "orders.accept", //   Accept room orders at the bar, 86 an item
  "guests.checkin", //  Check in
  "waitlist.manage", // Waitlist
  "bookings.manage", // Bookings
  "texts.send", //      Guest texts
  "runs.carry", //      Carry runs (I've got it, Delivered, Couldn't serve)
  "comps.reasonOnly", // Comp or void within the reason-only limit
  "cutoff.apply", //    Cut off a tab, a room or a guest
  "approvals.decide", // Approve (comps and voids over the limit, refunds, clock pauses, tips over 25%, paid-outs, a lower party size)
  "refunds.request", // Ask for a refund
  "drawer.count", //    Count a drawer (the bar drawer for bartenders, the front-desk drawer for the front desk)
  "night.close", //     Close the night
  "reports.view", //    Reports
  "admin.access", //    Admin (needs a passkey; a PIN never opens it)
  "admin.payments", //  Admin → Payments: the Stripe account, payouts and our plan
  "admin.team", //      Admin → Team: people, roles, invites, PIN resets, badges, languages and training mode
  "admin.console", //   Admin → Console: approving support access from our staff
  "tips.share", //      Shares tips and gratuity
] as const;
export type Action = (typeof actions)[number];

const allow = (...r: Role[]): Readonly<Record<Role, boolean>> => ({
  owner: r.includes("owner"),
  manager: r.includes("manager"),
  bartender: r.includes("bartender"),
  front_desk: r.includes("front_desk"),
  staff: r.includes("staff"),
});

/** The spec's table, row by row. Front desk's bar POS and accepting orders are "when covering the bar" (Admin can switch them off). */
export const defaultPermissions: Readonly<Record<Action, Readonly<Record<Role, boolean>>>> = {
  "payments.take": allow("owner", "manager", "bartender", "front_desk"),
  "pos.use": allow("owner", "manager", "bartender", "front_desk"),
  "orders.accept": allow("owner", "manager", "bartender", "front_desk"),
  "guests.checkin": allow("owner", "manager", "bartender", "front_desk", "staff"),
  "waitlist.manage": allow("owner", "manager", "bartender", "front_desk", "staff"),
  "bookings.manage": allow("owner", "manager", "bartender", "front_desk"),
  "texts.send": allow("owner", "manager", "bartender", "front_desk"),
  "runs.carry": allow("owner", "manager", "bartender", "front_desk", "staff"),
  "comps.reasonOnly": allow("owner", "manager", "bartender", "front_desk"),
  "cutoff.apply": allow("owner", "manager", "bartender", "front_desk"),
  "approvals.decide": allow("owner", "manager"),
  "refunds.request": allow("owner", "manager"),
  "drawer.count": allow("owner", "manager", "bartender", "front_desk"),
  "night.close": allow("owner", "manager"),
  "reports.view": allow("owner", "manager"),
  "admin.access": allow("owner", "manager"),
  "admin.payments": allow("owner"),
  "admin.team": allow("owner"),
  "admin.console": allow("owner"),
  "tips.share": allow("bartender", "front_desk", "staff"),
};

/** The rows Admin → Team may switch off: the front desk's bar POS and accepting orders "when covering the bar". */
export const switchableByAdmin: readonly { role: Role; action: Action }[] = [
  { role: "front_desk", action: "pos.use" },
  { role: "front_desk", action: "orders.accept" },
];

export function isAction(a: string): a is Action {
  return (actions as readonly string[]).includes(a);
}

export function isRole(r: string): r is Role {
  return (roles as readonly string[]).includes(r);
}

export interface PermissionOverride {
  readonly role: Role;
  readonly action: Action;
  readonly allowed: boolean;
  readonly needsApproval: boolean;
}

/** The venue's effective answer: its override if it has one, else the default. */
export function permissionFor(
  overrides: readonly PermissionOverride[],
  role: Role,
  action: Action,
): { allowed: boolean; needsApproval: boolean } {
  const override = overrides.find((o) => o.role === role && o.action === action);
  if (override) return { allowed: override.allowed, needsApproval: override.needsApproval };
  return { allowed: defaultPermissions[action][role], needsApproval: false };
}
