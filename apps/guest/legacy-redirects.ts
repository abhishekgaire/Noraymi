/**
 * The old west4karaoke.com's pages, and where each one goes on the new site (M9-09).
 *
 * The list comes only from West 4's own sources: the old site's public sitemap
 * (https://www.west4karaoke.com/sitemap.xml, read on Oct 8, 2026), then the
 * founder's additions from the host's page list, Search Console and analytics.
 * Nobody else's site is crawled. Add a page to LEGACY_PAGES and, when the new
 * site has no page at the same path, a row to LEGACY_REDIRECTS; the test in
 * legacy-redirects.test.ts then proves it answers.
 */

/** Every path the old site served, with its query when the old link carried one. */
export const LEGACY_PAGES: readonly string[] = [
  // pages-sitemap.xml
  "/",
  "/menu",
  "/room",
  "/reservation",
  // restaurants-menu-sitemap.xml
  "/menu?menu=menu",
];

/** Old paths the new site doesn't serve itself, and the page that replaces each (301). */
export const LEGACY_REDIRECTS: Readonly<Record<string, string>> = {
  "/reservation": "/book",
};

/**
 * Old manage-booking link prefixes. Their tokens can't carry over, so each goes to
 * the page with West 4's phone number. Empty until the founder reads the pattern off
 * an old confirmation email (docs/runbooks/domain-move.md).
 */
export const LEGACY_MANAGE_PREFIXES: readonly string[] = [];

/** Where an old manage-booking link lands. */
export const BOOKING_MOVED = "/booking-moved";

/** The room cookie (apps/api room-join.ts): a joined guest's phone has it. */
export const ROOM_COOKIE = "west4_room";

export interface LegacyAnswer {
  readonly to: string;
  readonly status: 301 | 302;
}

/** "/Reservation/" → "/reservation". */
export function normalizePath(path: string): string {
  const p = path.toLowerCase().replace(/\/+$/, "");
  return p === "" ? "/" : p;
}

/**
 * Where an old URL goes, or null when the new site serves the path itself.
 * The old `/room` was the rooms page; on the new site `/room` is a joined guest's
 * room, so a visitor without the room cookie goes to the home page's rooms section,
 * with a 302 so no browser remembers it for the day it joins a room.
 */
export function legacyRedirect(path: string, hasRoomCookie: boolean): LegacyAnswer | null {
  const p = normalizePath(path);
  const to = LEGACY_REDIRECTS[p];
  if (to) return { to, status: 301 };
  if (LEGACY_MANAGE_PREFIXES.some((prefix) => p.startsWith(normalizePath(prefix))))
    return { to: BOOKING_MOVED, status: 301 };
  if (p === "/room" && !hasRoomCookie) return { to: "/#rooms", status: 302 };
  return null;
}

/** `www.<host>` → the bare host, when SITE_HOST names it (the old site lived on www). */
export function canonicalHost(host: string, siteHost: string | undefined): string | null {
  if (!siteHost) return null;
  const h = host.toLowerCase();
  const s = siteHost.toLowerCase();
  return h === `www.${s}` ? s : null;
}
