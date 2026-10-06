import type { MessageKey } from "@west4/shared";

/**
 * The connection state (M8-01; spec 09 · Outages), pure so it can be tested
 * without a browser. Online; on backup internet (the router reports LTE);
 * offline (the browser has no network, or our API doesn't answer: the line
 * and LTE both down, or our cloud is); and back online with replayed orders
 * waiting (M8-05 counts them). Stripe's and Twilio's health ride along.
 */
export type ConnectionKind = "online" | "backup" | "offline";
export type VendorState = "ok" | "trouble";

export interface ConnectionInput {
  /** navigator.onLine and the window's online and offline events. */
  readonly browserOnline: boolean;
  /** The last poll of our API: answered (true), no answer (false), or not polled yet (null). */
  readonly apiReachable: boolean | null;
  /** The router reports the venue is on LTE. */
  readonly backupInternet: boolean;
  /** Replayed orders waiting for Accept after an outage (M8-05; 0 until then). */
  readonly replayedWaiting: number;
  readonly vendors: { readonly stripe: VendorState; readonly twilio: VendorState };
}

export function connectionKind(input: ConnectionInput): ConnectionKind {
  if (!input.browserOnline || input.apiReachable === false) return "offline";
  return input.backupInternet ? "backup" : "online";
}

export type BannerId = "backup" | "offline" | "replayed" | "stripe" | "twilio";

/** The screens with the outage banners: the Board, the bar POS and the bar orders screen. */
export const OUTAGE_SCREENS: readonly string[] = ["/tonight", "/bar", "/bar-orders"];

export function isOutageScreen(pathname: string): boolean {
  return OUTAGE_SCREENS.includes(pathname.replace(/\/+$/, "") || "/");
}

/**
 * The banners a screen shows, in order. The outage banners only on the
 * Board, the bar POS and the bar orders screen; the two vendor banners on
 * every staff screen, phones too. Offline, the vendors' state is unknown, so
 * their banners wait for the next answer.
 */
export function banners(input: ConnectionInput, outageScreen: boolean): BannerId[] {
  const kind = connectionKind(input);
  if (kind === "offline") return outageScreen ? ["offline"] : [];
  const out: BannerId[] = [];
  if (outageScreen && kind === "backup") out.push("backup");
  if (outageScreen && input.replayedWaiting > 0) out.push("replayed");
  if (input.vendors.stripe === "trouble") out.push("stripe");
  if (input.vendors.twilio === "trouble") out.push("twilio");
  return out;
}

export const BANNER_TEXT: Readonly<Record<BannerId, MessageKey>> = {
  backup: "connection.banner.backup",
  offline: "connection.banner.offline",
  replayed: "connection.banner.replayed",
  stripe: "connection.banner.stripe",
  twilio: "connection.banner.twilio",
};

/** "4 s ago", "3 min ago", "2 h ago": whole units, rounded down. */
export function syncedAgo(elapsedMs: number): { key: MessageKey; n: number } {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) return { key: "connection.ago.seconds", n: seconds };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { key: "connection.ago.minutes", n: minutes };
  return { key: "connection.ago.hours", n: Math.floor(minutes / 60) };
}

/**
 * The Board's footer: the connection and the last sync, "Online · synced 4 s
 * ago". Offline it keeps the last sync's age. It never says "works offline".
 */
export function footerKey(kind: ConnectionKind, lastSync: number | null): MessageKey {
  if (lastSync === null)
    return kind === "offline" ? "connection.footer.offlineNever" : "connection.footer.connecting";
  if (kind === "offline") return "connection.footer.offline";
  return kind === "backup" ? "connection.footer.backup" : "connection.footer.online";
}

/** A poll's failure that means our API is unreachable (no answer, or a gateway's 502, 503 or 504). */
export function unreachableStatus(status: number): boolean {
  return status === 0 || status === 502 || status === 503 || status === 504;
}
