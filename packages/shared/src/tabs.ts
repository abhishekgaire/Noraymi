/**
 * Bar tabs (M6-06; Payment flows · Bar tab with a growing hold; Data model ·
 * tabs): the seven states and the moves the Payment flows diagram allows,
 * and the consent line the bartender reads out at New tab.
 */
export const TAB_STATES = [
  "open",
  "tipping",
  "awaiting_tip",
  "captured",
  "walkout_captured",
  "capture_failed",
  "closed",
] as const;
export type TabState = (typeof TAB_STATES)[number];

/** States in which a card has its one open tab (the partial unique index on the fingerprint). */
export const TAB_CARD_HELD: readonly TabState[] = ["open", "tipping"];

/** The settled states, which can be reopened until the night closes. */
export const TAB_SETTLED: readonly TabState[] = ["captured", "walkout_captured", "closed"];

const MOVES: Readonly<Record<TabState, readonly TabState[]>> = {
  // Round sent (open → open), Close to the card, slip printed, charged at the cut-off, paid another
  // way or moved to a room, or a balance the hold can't cover.
  open: ["open", "tipping", "awaiting_tip", "walkout_captured", "closed", "capture_failed"],
  // Cancelled, tip picked, no answer in 2 minutes, or a total the hold can't cover.
  tipping: ["open", "captured", "awaiting_tip", "capture_failed"],
  // A tip from the slip or the sweeper, or a total the hold can't cover.
  awaiting_tip: ["captured", "capture_failed"],
  // A manager settles it.
  capture_failed: ["closed"],
  // Reopen, until the night closes.
  captured: ["open"],
  walkout_captured: ["open"],
  closed: ["open"],
};

/** Whether the Payment flows diagram allows a tab to move from one state to another. */
export function canMoveTab(from: TabState, to: TabState): boolean {
  return MOVES[from].includes(to);
}

export const isTabState = (s: string): s is TabState =>
  (TAB_STATES as readonly string[]).includes(s);

/** "$50" for whole dollars, "$50.50" otherwise: the hold as it's read out. */
function spokenDollars(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error("cents must be a whole number");
  const dollars = Math.floor(cents / 100);
  const rest = cents % 100;
  const whole = dollars.toLocaleString("en-US");
  return rest === 0 ? `$${whole}` : `$${whole}.${String(rest).padStart(2, "0")}`;
}

/** "04:30" → "4:30 AM", "00:00" → "12:00 AM". */
function spokenTime(hhmm: string): string {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error("time is HH:MM");
  const h = Number(m[1]);
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}

/**
 * The consent line read out at New tab, built from the `tabs` settings (the
 * opening hold and the tab cut-off), so another venue reads out its own
 * numbers. At West 4 ($50, 4:30 AM), the spec's words exactly.
 */
export function tabConsentLine(tabs: { openingHoldCents: number; cutOffAt: string }): string {
  return (
    `We'll hold ${spokenDollars(tabs.openingHoldCents)} on this card and add to it as you order. ` +
    `We charge your tab when you close out, or at ${spokenTime(tabs.cutOffAt)} if it's still open. ` +
    "Add your tip on the reader."
  );
}

/**
 * The tab's name from the cardholder's name a dip or swipe brings: "JESS PARKER" or
 * "PARKER/JESS" → "Jess P.". Null when there's no usable name (a tap or a phone).
 */
export function tabNameFromCard(cardholder: string | null | undefined): string | null {
  if (!cardholder) return null;
  const raw = cardholder.trim();
  if (!raw) return null;
  let first: string;
  let last: string;
  if (raw.includes("/")) {
    const [l = "", f = ""] = raw.split("/", 2);
    first = f.trim().split(/\s+/)[0] ?? "";
    last = l.trim();
  } else {
    const parts = raw.split(/\s+/);
    first = parts[0] ?? "";
    last = parts.length > 1 ? parts[parts.length - 1]! : "";
  }
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  if (!/\p{L}/u.test(first)) return null;
  const initial = last.match(/\p{L}/u)?.[0];
  return initial ? `${cap(first)} ${initial.toUpperCase()}.` : cap(first);
}
