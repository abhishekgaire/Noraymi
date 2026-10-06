import { describe, expect, it } from "vitest";
import { catalogs } from "@west4/shared";
import {
  banners,
  connectionKind,
  footerKey,
  isOutageScreen,
  syncedAgo,
  unreachableStatus,
  type ConnectionInput,
} from "./connection-state.js";

const base: ConnectionInput = {
  browserOnline: true,
  apiReachable: true,
  backupInternet: false,
  replayedWaiting: 0,
  vendors: { stripe: "ok", twilio: "ok" },
};

describe("the connection state (M8-01)", () => {
  it("is online, on backup internet, or offline", () => {
    expect(connectionKind(base)).toBe("online");
    expect(connectionKind({ ...base, backupInternet: true })).toBe("backup");
    expect(connectionKind({ ...base, browserOnline: false })).toBe("offline");
    // Our API doesn't answer: the line and LTE are down, or our cloud is.
    expect(connectionKind({ ...base, apiReachable: false, backupInternet: true })).toBe("offline");
    // Not polled yet is not offline.
    expect(connectionKind({ ...base, apiReachable: null })).toBe("online");
  });

  it("shows the outage banners on the Board, the bar POS and the bar orders screen only", () => {
    expect(isOutageScreen("/tonight")).toBe(true);
    expect(isOutageScreen("/bar")).toBe(true);
    expect(isOutageScreen("/bar-orders/")).toBe(true);
    expect(isOutageScreen("/calls")).toBe(false);
    expect(banners({ ...base, backupInternet: true }, true)).toEqual(["backup"]);
    expect(banners({ ...base, backupInternet: true }, false)).toEqual([]);
    expect(banners({ ...base, apiReachable: false }, true)).toEqual(["offline"]);
    expect(banners({ ...base, apiReachable: false }, false)).toEqual([]);
    expect(banners({ ...base, replayedWaiting: 3 }, true)).toEqual(["replayed"]);
  });

  it("shows the vendor banners on every staff screen, phones too, and hides them when cleared", () => {
    const trouble = { ...base, vendors: { stripe: "trouble", twilio: "trouble" } } as const;
    expect(banners(trouble, true)).toEqual(["stripe", "twilio"]);
    expect(banners(trouble, false)).toEqual(["stripe", "twilio"]);
    expect(banners({ ...trouble, backupInternet: true }, true)).toEqual([
      "backup",
      "stripe",
      "twilio",
    ]);
    expect(banners(base, false)).toEqual([]);
    // Offline, the vendors' state is unknown: only the pink banner.
    expect(banners({ ...trouble, browserOnline: false }, true)).toEqual(["offline"]);
  });

  it("words the footer's last sync and keeps it offline", () => {
    expect(syncedAgo(4_200)).toEqual({ key: "connection.ago.seconds", n: 4 });
    expect(syncedAgo(-50)).toEqual({ key: "connection.ago.seconds", n: 0 });
    expect(syncedAgo(185_000)).toEqual({ key: "connection.ago.minutes", n: 3 });
    expect(syncedAgo(2 * 3_600_000 + 5)).toEqual({ key: "connection.ago.hours", n: 2 });
    expect(footerKey("online", 1)).toBe("connection.footer.online");
    expect(footerKey("backup", 1)).toBe("connection.footer.backup");
    expect(footerKey("offline", 1)).toBe("connection.footer.offline");
    expect(footerKey("offline", null)).toBe("connection.footer.offlineNever");
    expect(footerKey("online", null)).toBe("connection.footer.connecting");
    expect(catalogs.en["connection.footer.online"].replace("{ago}", "4 s ago")).toBe(
      "Online · synced 4 s ago",
    );
  });

  it("takes no answer and a gateway's 502, 503 and 504 as unreachable", () => {
    expect([0, 502, 503, 504].every(unreachableStatus)).toBe(true);
    expect([401, 403, 404, 500].some(unreachableStatus)).toBe(false);
  });

  it("never says the screens work offline, in either language", () => {
    for (const catalog of [catalogs.en, catalogs.es])
      for (const text of Object.values(catalog))
        expect(String(text).toLowerCase()).not.toMatch(/works offline|funciona sin conexi[oó]n/);
  });

  it("uses the glossary's exact banner sentences", () => {
    expect(catalogs.en["connection.banner.backup"]).toBe(
      "On backup internet · card readers may take up to 2 min to switch",
    );
    expect(catalogs.en["connection.banner.offline"]).toBe(
      "Offline · read-only · orders queue with an offline code",
    );
    expect(catalogs.en["connection.banner.replayed"].replace("{n}", "3")).toBe(
      "Confirm replayed orders (3)",
    );
    expect(catalogs.en["connection.banner.stripe"]).toBe(
      "Stripe is having trouble · card payments may fail",
    );
    expect(catalogs.en["connection.banner.twilio"]).toBe("Texts are delayed");
  });
});
