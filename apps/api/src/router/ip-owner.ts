import { isIP } from "node:net";
import type { RouterLink } from "@west4/db";

/**
 * The fallback for a router without a maker API (M8-02; spec 09 · Router):
 * the bar computer's heartbeat arrives from the venue's public IP, and the
 * network that owns that IP is either the wired provider or the LTE carrier.
 * The owner is read from RDAP (RFC 9083, the registries' documented lookup),
 * outside any transaction, and kept an hour per address. The venue names
 * both networks in Admin → Printers & devices; until it does, the fallback
 * can't tell and leaves the router's state as it was.
 */
export const IP_OWNER_CACHE_MS = 60 * 60_000;

/** Addresses no registry owns: private, loopback, link-local, shared (CGNAT) and unique-local. */
export function isPublicIp(raw: string): boolean {
  const ip = raw.startsWith("::ffff:") ? raw.slice(7) : raw;
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    return true;
  }
  if (v === 6) {
    const low = ip.toLowerCase();
    return !(low === "::1" || low === "::" || /^f[cd]/.test(low) || /^fe[89ab]/.test(low));
  }
  return false;
}

/** The address a request came from, `hops` trusted proxies in front of us (each appends to X-Forwarded-For). */
export function publicIpOf(
  socketIp: string,
  forwardedFor: string | string[] | undefined,
  hops: number,
): string {
  if (hops <= 0) return socketIp;
  const list = (Array.isArray(forwardedFor) ? forwardedFor.join(",") : (forwardedFor ?? ""))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list[list.length - hops] ?? socketIp;
}

interface RdapEntity {
  readonly vcardArray?: unknown;
  readonly entities?: unknown;
}

/** Every name in an RDAP IP network answer: the network's name and each entity's `fn`, nested ones too. */
export function ownerFromRdap(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const names: string[] = [];
  const network = body as { name?: unknown; entities?: unknown };
  if (typeof network.name === "string") names.push(network.name);
  const walk = (entities: unknown, depth: number) => {
    if (!Array.isArray(entities) || depth > 3) return;
    for (const e of entities as RdapEntity[]) {
      const card = Array.isArray(e?.vcardArray) ? (e.vcardArray[1] as unknown) : null;
      if (Array.isArray(card))
        for (const field of card)
          if (Array.isArray(field) && field[0] === "fn" && typeof field[3] === "string")
            names.push(field[3]);
      walk(e?.entities, depth + 1);
    }
  };
  walk(network.entities, 0);
  return names.length > 0 ? names.join(" · ") : null;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Which network the owner names: the LTE carrier, the wired line, or null when it can't tell. */
export function classifyOwner(
  owner: string | null,
  link: Pick<RouterLink, "wired_owner" | "lte_owner">,
): "lte" | "wired" | null {
  if (!owner) return null;
  const text = ` ${norm(owner)} `;
  const names = (s: string | null) => (s && norm(s) ? ` ${norm(s)} ` : null);
  const lte = names(link.lte_owner);
  const wired = names(link.wired_owner);
  const isLte = lte !== null && text.includes(lte);
  const isWired = wired !== null && text.includes(wired);
  if (isLte === isWired) return null;
  return isLte ? "lte" : "wired";
}

export type IpOwnerLookup = (ip: string) => Promise<string | null>;

export function loadIpOwnerUrl(source: Record<string, string | undefined> = process.env): string {
  return (source["IP_OWNER_LOOKUP_URL"]?.trim() || "https://rdap.org/ip/").replace(/\/?$/, "/");
}

export function makeIpOwnerLookup(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
  realNow: () => number = Date.now,
): IpOwnerLookup {
  const cache = new Map<string, { owner: string | null; until: number }>();
  return async (ip) => {
    if (!isPublicIp(ip)) return null;
    const hit = cache.get(ip);
    if (hit && hit.until > realNow()) return hit.owner;
    try {
      const r = await fetchFn(`${baseUrl}${encodeURIComponent(ip)}`, {
        headers: { accept: "application/rdap+json, application/json" },
        signal: AbortSignal.timeout(5_000),
      });
      if (!r.ok) return null;
      const owner = ownerFromRdap(await r.json());
      cache.set(ip, { owner, until: realNow() + IP_OWNER_CACHE_MS });
      if (cache.size > 500) cache.delete(cache.keys().next().value!);
      return owner;
    } catch {
      return null;
    }
  };
}

/** How many proxies we trust in front of the API (staging's load balancer is one); 0 reads the socket. */
export function loadTrustedProxyHops(
  source: Record<string, string | undefined> = process.env,
): number {
  const n = Number(source["TRUSTED_PROXY_HOPS"] ?? "0");
  return Number.isInteger(n) && n >= 0 && n <= 5 ? n : 0;
}
