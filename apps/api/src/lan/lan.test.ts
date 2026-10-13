import { describe, expect, it } from "vitest";
import {
  DEFAULT_LAN_PORTS,
  checkLanIp,
  isPrivateIpv4,
  lanCorsRules,
  lanEnv,
  lanRoutes,
  parseLanPorts,
  pickLanIp,
  shellExports,
} from "./lan.js";

const v4 = (address: string, internal = false) => ({ family: "IPv4", address, internal });

describe("pickLanIp", () => {
  it("takes the Wi-Fi (en0) first, then en1", () => {
    expect(pickLanIp({ en1: [v4("10.0.0.9")], en0: [v4("192.168.1.20")] })).toBe("192.168.1.20");
    expect(pickLanIp({ en1: [v4("10.0.0.9")], lo0: [v4("127.0.0.1", true)] })).toBe("10.0.0.9");
  });

  it("skips loopback, IPv6, public addresses and Docker or VPN bridges", () => {
    expect(
      pickLanIp({
        lo0: [v4("127.0.0.1", true)],
        en0: [{ family: "IPv6", address: "fe80::1", internal: false }, v4("8.8.8.8")],
        bridge100: [v4("192.168.64.1")],
        utun3: [v4("10.8.0.2")],
      }),
    ).toBeNull();
    expect(pickLanIp({ bridge100: [v4("192.168.64.1")], en5: [v4("172.20.1.4")] })).toBe(
      "172.20.1.4",
    );
  });

  it("reads Node's numeric family too", () => {
    expect(pickLanIp({ en0: [{ family: 4, address: "192.168.0.7", internal: false }] })).toBe(
      "192.168.0.7",
    );
  });
});

describe("addresses", () => {
  it("knows the private ranges", () => {
    for (const ip of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1"])
      expect(isPrivateIpv4(ip)).toBe(true);
    for (const ip of ["172.32.0.1", "8.8.8.8", "fe80::1", "192.168.1"])
      expect(isPrivateIpv4(ip)).toBe(false);
  });

  it("refuses a --lan-ip that isn't an IPv4 address", () => {
    expect(checkLanIp(" 192.168.1.20 ")).toBe("192.168.1.20");
    expect(() => checkLanIp("laptop.local")).toThrow(/not an IPv4/);
    expect(() => checkLanIp("192.168.1.20; rm -rf /")).toThrow(/not an IPv4/);
  });
});

describe("lanEnv", () => {
  it("points every link the apps make at the laptop's address, over HTTPS", () => {
    const env = lanEnv({ ip: "192.168.1.20" });
    expect(env).toMatchObject({
      STAFF_APP_URL: "https://192.168.1.20:5173",
      GUEST_APP_URL: "https://192.168.1.20:3001",
      PAY_APP_URL: "https://192.168.1.20:3002",
      PAY_HOST: "192.168.1.20:3002",
      NEXT_PUBLIC_EVENTS_PORT: "3000",
      NEXT_ALLOWED_DEV_ORIGINS: "192.168.1.20",
      S3_ENDPOINT: "https://192.168.1.20:9443",
      LAN_SETUP_URL: "http://192.168.1.20:8080",
    });
  });

  it("keeps passkeys on the laptop's localhost: they can't be bound to an IP address", () => {
    const env = lanEnv({ ip: "10.0.0.5" });
    expect(env["WEBAUTHN_RP_ID"]).toBe("localhost");
    expect(env["WEBAUTHN_ORIGINS"]).toBe("http://localhost:5173,http://localhost:3000");
  });

  it("follows other ports", () => {
    const ports = parseLanPorts("13000,13001,13002,15173,19443,18080");
    const env = lanEnv({ ip: "10.0.0.5", ports });
    expect(env["STAFF_APP_URL"]).toBe("https://10.0.0.5:15173");
    expect(env["PAY_HOST"]).toBe("10.0.0.5:13002");
    expect(lanRoutes(ports)).toContainEqual({ name: "pay", listen: 13002, target: 13001 });
    expect(lanRoutes(ports)).toContainEqual({ name: "files", listen: 19443, target: 9000 });
  });
});

describe("parseLanPorts", () => {
  it("defaults, and refuses a bad list", () => {
    expect(parseLanPorts(undefined)).toEqual(DEFAULT_LAN_PORTS);
    expect(() => parseLanPorts("1,2,3")).toThrow(/six different ports/);
    expect(() => parseLanPorts("1,1,2,3,4,5")).toThrow(/six different ports/);
    expect(() => parseLanPorts("1,2,3,4,5,70000")).toThrow(/six different ports/);
  });
});

describe("lanRoutes", () => {
  it("serves the pay page from the guest site under its own port", () => {
    expect(lanRoutes()).toEqual([
      { name: "api", listen: 3000, target: 3000 },
      { name: "guest", listen: 3001, target: 3001 },
      { name: "pay", listen: 3002, target: 3001 },
      { name: "staff", listen: 5173, target: 5173 },
      { name: "files", listen: 9443, target: 9000 },
    ]);
  });
});

describe("lanCorsRules", () => {
  it("lets the apps upload photos from the laptop and from the Wi-Fi", () => {
    expect(lanCorsRules(lanEnv({ ip: "192.168.1.20" }))[0]!.AllowedOrigins).toEqual([
      "http://localhost:5173",
      "http://localhost:3001",
      "https://192.168.1.20:5173",
      "https://192.168.1.20:3001",
    ]);
  });
});

describe("shellExports", () => {
  it("single-quotes every value", () => {
    expect(shellExports({ A: "x y", B: "it's" })).toBe("export A='x y'\nexport B='it'\\''s'");
    expect(() => shellExports({ "A;B": "x" })).toThrow(/bad variable/);
  });
});
