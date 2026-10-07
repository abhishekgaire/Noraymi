/**
 * Support grants (M8-10; spec 02 · Support access). A grant lasts up to 60
 * minutes. A write grant names one action from this list and allows it once;
 * the rest of the session stays read-only. The list is the support actions the
 * spec names that the API can run today; M8-11's emergency path adds its own.
 */
export const SUPPORT_GRANT_MAX_MINUTES = 60;

export const SUPPORT_ACTIONS = ["requeue_print"] as const;
export type SupportAction = (typeof SUPPORT_ACTIONS)[number];

export function isSupportAction(value: unknown): value is SupportAction {
  return typeof value === "string" && (SUPPORT_ACTIONS as readonly string[]).includes(value);
}

/**
 * The emergency path (M8-11; spec 02 · Support access; spec 13 · On call): the
 * four support actions that fix things at 3 AM, and nothing else. Each needs a
 * reason and a second approver on our side, never the person who asked.
 */
export const EMERGENCY_ACTIONS = [
  "resync_payment",
  "cancel_reader_action",
  "requeue_print",
  "close_night",
] as const;
export type EmergencyAction = (typeof EMERGENCY_ACTIONS)[number];

export function isEmergencyAction(value: unknown): value is EmergencyAction {
  return typeof value === "string" && (EMERGENCY_ACTIONS as readonly string[]).includes(value);
}

/**
 * How long a request waits for the second approver before it expires (cautious default, M8-11:
 * the spec says "time-boxed" without a length). An approved action runs at once.
 */
export const EMERGENCY_APPROVAL_MINUTES = 15;

/**
 * The only fixes closing a stuck night may make (cautious default, M8-11: the spec doesn't say
 * what "close a stuck night" may change). Each names its target and a reason. An uncounted
 * drawer, an open tab or an open room is never skipped: the normal close still refuses them.
 */
export const NIGHT_FIXES = ["clock_out_shift", "clear_draft", "expire_approval"] as const;
export type NightFix = (typeof NIGHT_FIXES)[number];
