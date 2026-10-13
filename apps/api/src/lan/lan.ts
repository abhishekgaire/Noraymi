import { isIPv4 } from "node:net";

/**
 * The practice night from a laptop (`scripts/demo-start.sh --lan`): the apps keep running on the
 * laptop's own loopback ports, and a small HTTPS proxy (lan/proxy.ts) puts each one on the laptop's
 * Wi-Fi address, so the bar PCs and phones on the shop's network reach them. Browsers allow device
 * keys (WebCrypto), service workers and crypto.randomUUID only on a secure context, which is HTTPS
 * or localhost, so the Wi-Fi side is HTTPS with a certificate from the laptop's own local CA.
 * Passkeys can't be bound to an IP address, so they stay on the laptop (http://localhost:5173).
 * Pure helpers here, so each has a unit test.
 */

/** The ports the demo uses, on the laptop and on the Wi-Fi alike. */
export interface LanPorts {
  readonly api: number;
  readonly guest: number;
  /** The payment page's own origin (M4-15): the guest site again, under another port. */
  readonly pay: number;
  readonly staff: number;
  /** The local object store (RustFS, on the laptop's port 9000), where browsers upload photos. */
  readonly files: number;
  /** Plain HTTP: the page that hands out the local CA's certificate, and nothing else. */
  readonly setup: number;
}

export const DEFAULT_LAN_PORTS: LanPorts = {
  api: 3000,
  guest: 3001,
  pay: 3002,
  staff: 5173,
  files: 9443,
  setup: 8080,
};

/** The local object store's own port (docker-compose.yml). */
export const STORE_PORT = 9000;

/** LAN_PORTS="api,guest,pay,staff,files,setup" (a test run beside the real demo); unset: the defaults. */
export function parseLanPorts(text: string | undefined): LanPorts {
  if (!text) return DEFAULT_LAN_PORTS;
  const n = text.split(",").map((x) => Number(x.trim()));
  if (
    n.length !== 6 ||
    n.some((x) => !Number.isInteger(x) || x < 1 || x > 65535) ||
    new Set(n).size !== 6
  )
    throw new Error(
      `LAN_PORTS must be six different ports: api,guest,pay,staff,files,setup (got ${text})`,
    );
  const [api, guest, pay, staff, files, setup] = n as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return { api, guest, pay, staff, files, setup };
}

/** One forwarding rule: the Wi-Fi port, the loopback port behind it. */
export interface LanRoute {
  readonly name: string;
  readonly listen: number;
  readonly target: number;
}

export function lanRoutes(ports: LanPorts = DEFAULT_LAN_PORTS): LanRoute[] {
  return [
    { name: "api", listen: ports.api, target: ports.api },
    { name: "guest", listen: ports.guest, target: ports.guest },
    // The pay host is told apart by its Host header (apps/guest/proxy.ts), which the proxy keeps.
    { name: "pay", listen: ports.pay, target: ports.guest },
    { name: "staff", listen: ports.staff, target: ports.staff },
    // Presigned uploads and downloads go straight from the browser to the store; the signature
    // covers the Host header, which the proxy keeps, so the API signs for this address.
    { name: "files", listen: ports.files, target: STORE_PORT },
  ];
}

const PRIVATE = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./];

export function isPrivateIpv4(ip: string): boolean {
  return isIPv4(ip) && PRIVATE.some((p) => p.test(ip));
}

type Interfaces = Record<
  string,
  readonly { family: string | number; address: string; internal: boolean }[] | undefined
>;

/**
 * The laptop's address on the shop's Wi-Fi: en0 (a MacBook's Wi-Fi), then en1, then any other
 * private IPv4 address. Null when the laptop isn't on a network.
 */
export function pickLanIp(interfaces: Interfaces): string | null {
  const v4 = (name: string) =>
    (interfaces[name] ?? []).filter(
      (a) => !a.internal && (a.family === "IPv4" || a.family === 4) && isPrivateIpv4(a.address),
    );
  for (const name of ["en0", "en1"]) {
    const found = v4(name)[0];
    if (found) return found.address;
  }
  for (const name of Object.keys(interfaces).sort()) {
    // Docker's and VPNs' bridges aren't the Wi-Fi.
    if (/^(lo|bridge|utun|docker|veth|vmnet|awdl|llw)/.test(name)) continue;
    const found = v4(name)[0];
    if (found) return found.address;
  }
  return null;
}

/** A --lan-ip the founder typed: an IPv4 address, nothing else. */
export function checkLanIp(ip: string): string {
  const v = ip.trim();
  if (!isIPv4(v)) throw new Error(`not an IPv4 address: ${JSON.stringify(ip)}`);
  return v;
}

export interface LanEnvInput {
  /** The laptop's Wi-Fi address: what every link carries. */
  readonly ip: string;
  readonly ports?: LanPorts;
}

/**
 * The environment the API, the guest site and the demo scripts get, so every link they make
 * (invites, the room's QR, Pay my share, receipts, emails) opens from a phone or a bar PC.
 */
export function lanEnv(input: LanEnvInput): Record<string, string> {
  const host = checkLanIp(input.ip);
  const p = input.ports ?? DEFAULT_LAN_PORTS;
  const at = (port: number) => `https://${host}:${port}`;
  return {
    STAFF_APP_URL: at(p.staff),
    GUEST_APP_URL: at(p.guest),
    PAY_APP_URL: at(p.pay),
    PAY_HOST: `${host}:${p.pay}`,
    S3_ENDPOINT: at(p.files),
    // Passkeys are bound to a domain, never an IP address: they stay on the laptop's localhost,
    // where the owner and manager invites are opened.
    WEBAUTHN_RP_ID: "localhost",
    WEBAUTHN_ORIGINS: `http://localhost:${p.staff},http://localhost:${p.api}`,
    // The guest pages' live channel goes straight to the API's port on the same host (app/live.ts).
    NEXT_PUBLIC_EVENTS_PORT: String(p.api),
    // next dev answers its own scripts and hot reload only to origins it knows.
    NEXT_ALLOWED_DEV_ORIGINS: host,
    LAN_HOST: host,
    LAN_SETUP_URL: `http://${host}:${p.setup}`,
  };
}

/** The photo bucket's CORS rules: the laptop's own apps, and the same apps on the Wi-Fi. */
export function lanCorsRules(env: Record<string, string>, ports: LanPorts = DEFAULT_LAN_PORTS) {
  const origins = [
    `http://localhost:${ports.staff}`,
    `http://localhost:${ports.guest}`,
    env["STAFF_APP_URL"],
    env["GUEST_APP_URL"],
  ].filter((o): o is string => !!o);
  return [
    {
      AllowedOrigins: [...new Set(origins)],
      AllowedMethods: ["GET", "POST"],
      AllowedHeaders: ["*"],
      MaxAgeSeconds: 3000,
    },
  ];
}

/** `export NAME='value'` lines for the shell to eval; values are single-quoted. */
export function shellExports(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) throw new Error(`bad variable name ${k}`);
      return `export ${k}='${v.replace(/'/g, `'\\''`)}'`;
    })
    .join("\n");
}
