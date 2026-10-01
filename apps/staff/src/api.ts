import type { Action, Locale, ModuleStates, Role } from "@west4/shared";

/** The API said no: its error code and message (apps/api http/errors.ts). */
export class ApiCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** The error's details, such as a refusal's reason ("link", "not_open"). */
    readonly details: Readonly<Record<string, unknown>> = {},
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

const desktop = () => (typeof window === "undefined" ? undefined : window.west4);

export function setSessionToken(value: string | null): void {
  token = value;
  const shell = desktop();
  if (shell) {
    // The keychain holds it; no plain file ever does.
    void (value ? shell.token.set(value) : shell.token.clear()).catch(() => {});
    return;
  }
  try {
    if (value) sessionStorage.setItem(TOKEN_KEY, value);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // No storage: the token lasts for this load.
  }
}

/** Before the first render: the desktop shell hands back the token it kept. */
export async function loadSessionToken(): Promise<void> {
  const shell = desktop();
  if (!shell) return;
  try {
    token = await shell.token.get();
  } catch {
    token = null;
  }
}

export function sessionToken(): string | null {
  if (token) return token;
  if (desktop()) return null;
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
/**
 * Team changes ask for the passkey again (spec 02): one WebAuthn ceremony
 * gives a single-use token the next call carries as X-Step-Up.
 */
export async function stepUpToken(): Promise<string> {
  const start = await api<{ options: unknown }>("POST", "/v1/auth/step-up", { step: "start" });
  const ctor = (
    globalThis as {
      PublicKeyCredential?: {
        parseRequestOptionsFromJSON?: (o: unknown) => PublicKeyCredentialRequestOptions;
      };
    }
  ).PublicKeyCredential;
  if (!ctor?.parseRequestOptionsFromJSON)
    throw new ApiCallError(0, "passkey_unsupported", "no passkeys here");
  const credential = (await navigator.credentials.get({
    publicKey: ctor.parseRequestOptionsFromJSON(start.options),
  })) as (Credential & { toJSON(): unknown }) | null;
  if (!credential) throw new ApiCallError(0, "cancelled", "the passkey prompt was closed");
  const finish = await api<{ step_up_token: string }>("POST", "/v1/auth/step-up", {
    step: "finish",
    credential: credential.toJSON(),
  });
  return finish.step_up_token;
}

export async function api<T>(
  method: "GET" | "POST" | "PATCH" | "PUT",
  path: string,
  body?: unknown,
  options: { stepUp?: string } = {},
): Promise<T> {
  let response: Response;
  try {
    const init: RequestInit = {
      method,
      credentials: "same-origin",
      headers: { ...sessionHeaders(), ...(options.stepUp ? { "x-step-up": options.stepUp } : {}) },
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
      error?: { code?: string; message?: string; details?: Record<string, unknown> };
    } | null;
    throw new ApiCallError(
      response.status,
      parsed?.error?.code ?? "unknown",
      parsed?.error?.message ?? response.statusText,
      parsed?.error?.details ?? {},
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
