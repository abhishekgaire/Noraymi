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
