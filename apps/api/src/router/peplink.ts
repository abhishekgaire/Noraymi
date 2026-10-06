import type { RouterLink } from "@west4/db";

/**
 * The router maker's documented cloud API (M8-02; spec 09 · Router). The
 * pick is a Peplink dual-WAN LTE router read through InControl 2's public
 * REST API (https://incontrol2.peplink.com/api/ic2-api-doc): an OAuth2
 * client-credentials token from /api/oauth2/token, then
 * GET /rest/o/{organization_id}/d/{device_id}, whose `interfaces` list each
 * WAN with its `type`, `status` ("Connected", "Disconnected", "Disabled",
 * "No SIM Card Detected", "No Cable Detected") and flags. Only that
 * documented API, never an undocumented one. Calls run outside any database
 * transaction; a read changes nothing on the router, so it needs no
 * idempotency key.
 */
export interface MakerReading {
  /** The LTE backup is ready: a cellular WAN that isn't disabled, without a SIM, over quota or switched off. */
  readonly backupReady: boolean;
  /** No wired WAN is up and a cellular one is: the venue runs on LTE. */
  readonly onBackupNow: boolean;
}

export interface RouterAdapter {
  /** Null: no answer, or the maker says the router itself is offline. */
  read(link: RouterLink): Promise<MakerReading | null>;
}

export interface PeplinkSettings {
  readonly apiUrl: string;
  readonly clientId: string | null;
  readonly clientSecret: string | null;
}

export function loadPeplinkSettings(
  source: Record<string, string | undefined> = process.env,
): PeplinkSettings {
  const value = (key: string) => source[key]?.trim() || null;
  return {
    apiUrl: (value("PEPLINK_API_URL") ?? "https://api.ic.peplink.com").replace(/\/+$/, ""),
    clientId: value("PEPLINK_CLIENT_ID"),
    clientSecret: value("PEPLINK_CLIENT_SECRET"),
  };
}

interface PeplinkInterface {
  readonly type?: unknown;
  readonly name?: unknown;
  readonly status?: unknown;
  readonly is_overall_up?: unknown;
  readonly is_quota_exceed?: unknown;
  readonly is_manual_disconnect?: unknown;
}

const CELLULAR = /gobi|cellular|modem|lte|5g|4g|3g|mobile/i;
const WIFI = /wifi|wlan|wireless/i;
const NOT_READY = new Set(["disabled", "no sim card detected"]);

const kindOf = (i: PeplinkInterface): "cellular" | "wifi" | "wired" => {
  const label = `${typeof i.type === "string" ? i.type : ""} ${typeof i.name === "string" ? i.name : ""}`;
  return CELLULAR.test(label) ? "cellular" : WIFI.test(label) ? "wifi" : "wired";
};
const statusOf = (i: PeplinkInterface) =>
  typeof i.status === "string" ? i.status.trim().toLowerCase() : "";
const isUp = (i: PeplinkInterface) => statusOf(i) === "connected" && i.is_overall_up !== 0;

/**
 * Reads one device answer ({ resp_code, data: { status, interfaces } }).
 * Null when the call didn't succeed or the maker reports the router offline.
 */
export function readPeplinkDevice(body: unknown): MakerReading | null {
  if (typeof body !== "object" || body === null) return null;
  const answer = body as { resp_code?: unknown; data?: unknown };
  if (answer.resp_code !== "SUCCESS" || typeof answer.data !== "object" || answer.data === null)
    return null;
  const device = answer.data as { status?: unknown; interfaces?: unknown };
  if (typeof device.status === "string" && device.status.toLowerCase() !== "online") return null;
  const interfaces = Array.isArray(device.interfaces)
    ? (device.interfaces as PeplinkInterface[]).filter((i) => typeof i === "object" && i !== null)
    : [];
  const cellular = interfaces.filter((i) => kindOf(i) === "cellular");
  const wired = interfaces.filter((i) => kindOf(i) === "wired");
  const backupReady = cellular.some(
    (i) => !NOT_READY.has(statusOf(i)) && i.is_quota_exceed !== 1 && i.is_manual_disconnect !== 1,
  );
  const onBackupNow = !wired.some(isUp) && cellular.some(isUp);
  return { backupReady, onBackupNow };
}

type Fetch = typeof fetch;

export function makePeplinkAdapter(
  settings: PeplinkSettings,
  fetchFn: Fetch = fetch,
  realNow: () => number = Date.now,
): RouterAdapter | null {
  const { clientId, clientSecret } = settings;
  if (!clientId || !clientSecret) return null;
  let token: { value: string; until: number } | null = null;

  const accessToken = async (): Promise<string | null> => {
    if (token && token.until > realNow()) return token.value;
    const r = await fetchFn(`${settings.apiUrl}/api/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
      }).toString(),
      signal: AbortSignal.timeout(5_000),
    });
    if (!r.ok) return null;
    const body = (await r.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string") return null;
    const seconds = typeof body.expires_in === "number" ? body.expires_in : 3600;
    // Renew a minute early.
    token = { value: body.access_token, until: realNow() + Math.max(0, seconds - 60) * 1000 };
    return token.value;
  };

  return {
    async read(link) {
      if (link.maker !== "peplink" || !link.maker_org_id || !link.maker_device_id) return null;
      try {
        const bearer = await accessToken();
        if (!bearer) return null;
        const path = `/rest/o/${encodeURIComponent(link.maker_org_id)}/d/${encodeURIComponent(link.maker_device_id)}`;
        const r = await fetchFn(`${settings.apiUrl}${path}`, {
          headers: { authorization: `Bearer ${bearer}` },
          signal: AbortSignal.timeout(5_000),
        });
        if (r.status === 401) token = null;
        if (!r.ok) return null;
        return readPeplinkDevice(await r.json());
      } catch {
        return null;
      }
    },
  };
}
