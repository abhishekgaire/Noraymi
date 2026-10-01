import type { Action, Locale, ModuleStates, Role } from "@west4/shared";

/** The API said no: its error code and message (apps/api http/errors.ts). */
export class ApiCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The request never reached the API: offline, or the server is down. */
export class NetworkError extends Error {}

/**
 * A shared screen's session is a bearer token (the desktop app keeps it in the
 * keychain, M1-28; a browser keeps it for the tab). A phone's or a browser's
 * own session is the cookie, which travels by itself.
 */
const TOKEN_KEY = "west4.staff.token";
let token: string | null = null;

export function setSessionToken(value: string | null): void {
  token = value;
  try {
    if (value) sessionStorage.setItem(TOKEN_KEY, value);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // No storage: the token lasts for this load.
  }
}

export function sessionToken(): string | null {
  if (token) return token;
  try {
    token = sessionStorage.getItem(TOKEN_KEY);
  } catch {
    token = null;
  }
  return token;
}

export function sessionHeaders(): Record<string, string> {
  const t = sessionToken();
  return t ? { authorization: `Bearer ${t}` } : {};
}

/** One call to the API on this origin. The session cookie or token goes along by itself. */
export async function api<T>(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    const init: RequestInit = {
      method,
      credentials: "same-origin",
      headers: { ...sessionHeaders() },
    };
    if (body !== undefined) {
      init.headers = { ...init.headers, "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    response = await fetch(path, init);
  } catch (error) {
    throw new NetworkError(error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) {
    const parsed = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new ApiCallError(
      response.status,
      parsed?.error?.code ?? "unknown",
      parsed?.error?.message ?? response.statusText,
    );
  }
  return (await response.json()) as T;
}

/** One venue the signed-in person works at, as GET /v1/auth/me returns it (M1-21). */
export interface Membership {
  readonly venue_id: string;
  readonly membership_id: string;
  readonly role: Role;
  readonly locale: Locale;
  readonly venue: {
    readonly id: string;
    readonly name: string;
    readonly time_zone: string;
    /** "06:00": the business date turns over here. */
    readonly day_cutover: string;
  };
  readonly modules: ModuleStates;
  readonly permissions: readonly Action[];
}

export interface Me {
  readonly user: { readonly id: string; readonly name: string; readonly email: string | null };
  readonly session: {
    readonly id: string;
    readonly assurance: "passkey" | "authenticator" | "pin" | "badge";
    readonly expires_at: string;
  };
  readonly memberships: readonly Membership[];
  /** The venue's clock at the moment of the answer, an ISO instant. */
  readonly server_time: string;
}
