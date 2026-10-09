import type { GoogleHours } from "@west4/rules";
import { SCOPE, type GoogleSettings } from "./settings.js";

/** Google answered with an error, or didn't answer in time. */
export class GoogleError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "GoogleError";
  }
}

export interface GoogleLocation {
  readonly name: string;
  readonly title: string;
}

const TIMEOUT_MS = 15_000;

/**
 * The few calls M5-15 needs from Google's published APIs: OAuth (code and
 * refresh token), the locations the venue's Google user manages, and a PATCH
 * of one location's regular and special hours. The PATCH sends the whole
 * schedule every time, so sending it twice leaves the same result (Google's
 * Business Information API takes no idempotency key). Never called inside a
 * database transaction.
 */
export class GoogleClient {
  constructor(readonly settings: GoogleSettings) {}

  get enabled(): boolean {
    return this.settings.mode !== "off";
  }

  authorizeUrl(state: string, redirectUri: string): string {
    const q = new URLSearchParams({
      client_id: this.settings.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent",
      state,
    });
    return `${this.settings.endpoints.authorize}?${q.toString()}`;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<string> {
    const r = await this.token({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    });
    if (!r.refresh_token) throw new GoogleError("Google sent no refresh token", null);
    return r.refresh_token;
  }

  async accessToken(refreshToken: string): Promise<string> {
    const r = await this.token({ grant_type: "refresh_token", refresh_token: refreshToken });
    if (!r.access_token) throw new GoogleError("Google sent no access token", null);
    return r.access_token;
  }

  async listLocations(accessToken: string): Promise<GoogleLocation[]> {
    const out: GoogleLocation[] = [];
    const accounts = await this.json<{ accounts?: { name: string }[] }>(
      "GET",
      `${this.settings.endpoints.accounts}/accounts`,
      accessToken,
    );
    for (const a of accounts.accounts ?? []) {
      let page: string | undefined;
      do {
        const q = new URLSearchParams({ readMask: "name,title", pageSize: "100" });
        if (page) q.set("pageToken", page);
        const r = await this.json<{
          locations?: { name: string; title?: string }[];
          nextPageToken?: string;
        }>(
          "GET",
          `${this.settings.endpoints.info}/${a.name}/locations?${q.toString()}`,
          accessToken,
        );
        for (const l of r.locations ?? []) out.push({ name: l.name, title: l.title ?? l.name });
        page = r.nextPageToken;
      } while (page);
    }
    return out;
  }

  async patchHours(accessToken: string, location: string, hours: GoogleHours): Promise<void> {
    if (!/^locations\/[\w-]+$/.test(location))
      throw new GoogleError(`not a location name: ${location}`, null);
    await this.json(
      "PATCH",
      `${this.settings.endpoints.info}/${location}?updateMask=regularHours,specialHours`,
      accessToken,
      hours,
    );
  }

  private async token(
    form: Record<string, string>,
  ): Promise<{ access_token?: string; refresh_token?: string }> {
    const body = new URLSearchParams({
      ...form,
      client_id: this.settings.clientId,
      client_secret: this.settings.clientSecret,
    });
    return this.send(this.settings.endpoints.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  }

  private json<T>(method: string, url: string, accessToken: string, body?: unknown): Promise<T> {
    return this.send<T>(url, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  private async send<T>(url: string, init: RequestInit): Promise<T> {
    if (!this.enabled) throw new GoogleError("Google isn't set up here", null);
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new GoogleError("no answer from Google", null);
    }
    const text = await res.text();
    if (!res.ok) {
      // Only Google's own error message, never the request (it carries tokens).
      let message = `Google answered ${res.status}`;
      try {
        const e = JSON.parse(text) as { error?: { message?: string } | string };
        const m = typeof e.error === "string" ? e.error : e.error?.message;
        if (m) message = `${message}: ${m.slice(0, 200)}`;
      } catch {
        // not JSON
      }
      throw new GoogleError(message, res.status);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
}
