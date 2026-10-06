import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  classifyOwner,
  isPublicIp,
  loadTrustedProxyHops,
  makeIpOwnerLookup,
  ownerFromRdap,
  publicIpOf,
} from "./ip-owner.js";

/** The fallback without a maker API (M8-02): network-owner fixtures in RDAP's shape (RFC 9083). */
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const link = { wired_owner: "Example Fiber", lte_owner: "Example Wireless" };

describe("the network owner behind the bar computer's public IP", () => {
  it("reads the network's name and every entity's name", () => {
    expect(ownerFromRdap(fixture("rdap-wired"))).toBe(
      "EXAMPLE-FIBER-NYC · Example Fiber Inc. · Network Operations",
    );
    expect(ownerFromRdap(fixture("rdap-lte"))).toBe("EXWL-BLK · Example Wireless LLC");
    expect(ownerFromRdap(null)).toBeNull();
  });

  it("tells the wired provider from the LTE carrier by the names the venue set", () => {
    expect(classifyOwner(ownerFromRdap(fixture("rdap-wired")), link)).toBe("wired");
    expect(classifyOwner(ownerFromRdap(fixture("rdap-lte")), link)).toBe("lte");
    expect(classifyOwner("EXAMPLE WIRELESS, L.L.C.", link)).toBe("lte");
  });

  it("can't tell without the names, with an owner it doesn't know, or when both match", () => {
    expect(
      classifyOwner(ownerFromRdap(fixture("rdap-lte")), { wired_owner: null, lte_owner: null }),
    ).toBeNull();
    expect(classifyOwner("Some Other Network", link)).toBeNull();
    expect(classifyOwner("Example Fiber and Example Wireless", link)).toBeNull();
    expect(classifyOwner(null, link)).toBeNull();
    // A name inside a longer word doesn't count.
    expect(classifyOwner("Examplewireless", link)).toBeNull();
  });

  it("only public addresses are looked up", () => {
    for (const ip of [
      "10.0.0.4",
      "192.168.1.20",
      "172.20.0.1",
      "127.0.0.1",
      "100.72.1.1",
      "169.254.0.9",
      "::1",
      "fd00::1",
      "fe80::2",
      "::ffff:192.168.1.2",
      "nope",
    ])
      expect(isPublicIp(ip), ip).toBe(false);
    for (const ip of ["203.0.113.7", "198.51.100.20", "2001:db8::1", "::ffff:203.0.113.7"])
      expect(isPublicIp(ip), ip).toBe(true);
  });

  it("reads the address from the socket, or behind trusted proxies from X-Forwarded-For", () => {
    expect(publicIpOf("10.0.0.2", "1.2.3.4, 203.0.113.7", 0)).toBe("10.0.0.2");
    expect(publicIpOf("10.0.0.2", "1.2.3.4, 203.0.113.7", 1)).toBe("203.0.113.7");
    expect(publicIpOf("10.0.0.2", undefined, 1)).toBe("10.0.0.2");
    expect(loadTrustedProxyHops({})).toBe(0);
    expect(loadTrustedProxyHops({ TRUSTED_PROXY_HOPS: "1" })).toBe(1);
    expect(loadTrustedProxyHops({ TRUSTED_PROXY_HOPS: "x" })).toBe(0);
  });

  it("asks RDAP once an hour per address, and never for a private one", async () => {
    const asked: string[] = [];
    let now = 0;
    const lookup = makeIpOwnerLookup(
      "https://rdap.example/ip/",
      (async (url: string) => {
        asked.push(url);
        return Response.json(fixture("rdap-lte"));
      }) as unknown as typeof fetch,
      () => now,
    );
    expect(await lookup("198.51.100.20")).toBe("EXWL-BLK · Example Wireless LLC");
    expect(await lookup("198.51.100.20")).toBe("EXWL-BLK · Example Wireless LLC");
    expect(await lookup("192.168.1.2")).toBeNull();
    now = 61 * 60_000;
    await lookup("198.51.100.20");
    expect(asked).toEqual([
      "https://rdap.example/ip/198.51.100.20",
      "https://rdap.example/ip/198.51.100.20",
    ]);
  });
});
