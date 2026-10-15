import {
  isOfflineRead,
  type Action,
  type Locale,
  type ModuleId,
  type ModuleStates,
  type Role,
} from "@west4/shared";
import { unreachableStatus } from "./connection-state.js";
import { TRIAL_PATH, trialMark } from "./trial-capture.js";
import { noteKept, noteLive, offlineStore } from "./offline.js";

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

/**
 * A read on the desktop app's offline list (M8-03): each live answer is kept
 * in the encrypted cache, and when our API doesn't answer (no network, or a
 * gateway's 502, 503 or 504) the kept one comes back instead. A refusal is
 * still an answer and is never covered up. Writes never come here.
 */
export async function withOfflineRead<T>(
  method: string,
  path: string,
  live: () => Promise<T>,
): Promise<T> {
  const store = method === "GET" && isOfflineRead(path) ? offlineStore() : null;
  if (!store) return live();
  try {
    const answer = await live();
    noteLive();
    void store.save(path, JSON.stringify(answer)).catch(() => false);
    return answer;
  } catch (error) {
    const unreachable =
      error instanceof NetworkError ||
      (error instanceof ApiCallError && unreachableStatus(error.status));
    if (!unreachable) throw error;
    const kept = await store.read(path).catch(() => null);
    if (!kept) throw error;
    noteKept(kept.synced_at);
    return kept.body as T;
  }
}

/**
 * Ask for the PIN again (P-10): the screen that asks (PinAgainDialog, mounted once in the shell).
 * It gets the action and, after a wrong try, why; it answers the PIN typed, or null when closed.
 */
export type PinAgainPrompt = (
  action: string,
  problem: "wrong" | "locked" | null,
) => Promise<string | null>;
let pinAgainPrompt: PinAgainPrompt | null = null;
export function setPinAgainPrompt(prompt: PinAgainPrompt | null): void {
  pinAgainPrompt = prompt;
}

/**
 * A manager's PIN where the approval is asked (U-08; spec 02 · Approvals): with approvals decided by
 * a manager's PIN at the register, a write that answers approval_pending opens the dialog
 * (ManagerPinDialog, mounted once) right there. The dialog sends the PIN to the server, which decides
 * and audits it; it answers what was decided, with words to show, or null when closed for later.
 */
export interface ManagerPinAsk {
  readonly venueId: string;
  readonly approvalId: string;
  /** Who the request was routed to; picked first when they're on the clock. */
  readonly routedTo: string | null;
}
export type ManagerPinOutcome = {
  readonly status: "approved" | "declined" | "expired";
  /** Why, in the staff's language: "Declined by Andy C.", "No longer needed". */
  readonly message: string;
} | null;
export type ManagerPinPrompt = (ask: ManagerPinAsk) => Promise<ManagerPinOutcome>;
let managerPinPrompt: ManagerPinPrompt | null = null;
export function setManagerPinPrompt(prompt: ManagerPinPrompt | null): void {
  managerPinPrompt = prompt;
}
/** A window event: an approval asked or decided on this screen, for the waiting strip (U-08). */
export const APPROVALS_CHANGED = "west4:approvals-changed";
/** Open the manager's PIN dialog for a pending approval (the waiting strip's Manager's PIN too). */
export function askManagerPin(ask: ManagerPinAsk): Promise<ManagerPinOutcome> {
  return managerPinPrompt ? managerPinPrompt(ask) : Promise.resolve(null);
}

export async function api<T>(
  method: "GET" | "PATCH" | "POST" | "PUT",
  path: string,
  body?: unknown,
  options: { stepUp?: string; idempotencyKey?: string } = {},
): Promise<T> {
  const answer = await withOfflineRead(method, path, () =>
    withPinAgain<T>(method, path, body, options),
  );
  return method === "GET" ? answer : withManagerPin(path, answer);
}

interface PinPending {
  readonly status: "approval_pending";
  readonly approval_id: string;
  readonly decided_with: "pin";
  readonly waiting_for?: { readonly user_id?: string } | null;
}
const pinPending = (x: unknown): x is PinPending =>
  typeof x === "object" &&
  x !== null &&
  (x as { status?: unknown }).status === "approval_pending" &&
  (x as { decided_with?: unknown }).decided_with === "pin" &&
  typeof (x as { approval_id?: unknown }).approval_id === "string";

/**
 * After a write (U-08): each approval it left pending for a manager's PIN, at the top of the answer or
 * one level down (a fault's pause and comp), is asked for in the dialog. Approved, the screen gets the
 * answer as if no approval were needed (`approved`, nobody to wait for); declined or no longer
 * needed, a top-level one is the call's refusal, in words; closed for later, the answer is unchanged
 * and the waiting strip keeps offering Manager's PIN.
 */
async function withManagerPin<T>(path: string, answer: T): Promise<T> {
  if (!managerPinPrompt || typeof answer !== "object" || answer === null) return answer;
  const venueId = /^\/v1\/venues\/([^/]+)\//.exec(path)?.[1];
  if (!venueId) return answer;
  const decide = async (p: PinPending) => {
    const outcome = await askManagerPin({
      venueId,
      approvalId: p.approval_id,
      routedTo: p.waiting_for?.user_id ?? null,
    });
    // The waiting strip reads the list again at once (a shared screen gets no per-person events).
    if (typeof window !== "undefined") window.dispatchEvent(new Event(APPROVALS_CHANGED));
    return outcome;
  };
  if (pinPending(answer)) {
    const outcome = await decide(answer);
    if (!outcome) return answer;
    if (outcome.status === "approved") return { ...answer, status: "approved", waiting_for: null };
    throw new ApiCallError(409, `approval_${outcome.status}`, outcome.message);
  }
  let changed: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(answer as Record<string, unknown>)) {
    if (!pinPending(value)) continue;
    const outcome = await decide(value);
    if (!outcome) continue;
    changed = { ...(changed ?? (answer as Record<string, unknown>)) };
    changed[key] = { ...value, status: outcome.status, waiting_for: null };
  }
  return (changed ?? answer) as T;
}

/**
 * A write the venue asks the PIN again for answers pin_again_required (P-10): the person types
 * their own PIN and the same call goes again with it, the same Idempotency-Key and all. A wrong
 * PIN asks again; closing the dialog gives the screen the refusal.
 */
async function withPinAgain<T>(
  method: "GET" | "POST" | "PATCH" | "PUT",
  path: string,
  body: unknown,
  options: { stepUp?: string; idempotencyKey?: string },
): Promise<T> {
  try {
    return await liveApi<T>(method, path, body, options);
  } catch (error) {
    if (!(error instanceof ApiCallError) || error.code !== "pin_again_required" || !pinAgainPrompt)
      throw error;
    const action = typeof error.details["action"] === "string" ? error.details["action"] : "";
    let problem: "wrong" | "locked" | null = null;
    for (;;) {
      const pin = await pinAgainPrompt(action, problem);
      if (pin === null) throw error;
      try {
        return await liveApi<T>(method, path, body, { ...options, pinAgain: pin });
      } catch (again) {
        if (again instanceof ApiCallError && again.code === "unauthorized") problem = "wrong";
        else if (again instanceof ApiCallError && again.code === "rate_limited") problem = "locked";
        else throw again;
      }
    }
  }
}

async function liveApi<T>(
  method: "GET" | "POST" | "PATCH" | "PUT",
  path: string,
  body: unknown,
  options: { stepUp?: string; idempotencyKey?: string; pinAgain?: string },
): Promise<T> {
  let response: Response;
  try {
    const init: RequestInit = {
      method,
      credentials: "same-origin",
      headers: {
        ...sessionHeaders(),
        ...(options.stepUp ? { "x-step-up": options.stepUp } : {}),
        // The person's own PIN, typed again for an action the venue asks it for (P-10).
        ...(options.pinAgain ? { "x-pin-again": options.pinAgain } : {}),
        // Money routes need one (M4-11): a retry of the same tap is the same payment.
        ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
      },
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
    // The timed staff trial counts the errors a screen showed (M9-11); a no-op outside training.
    if (!TRIAL_PATH.test(path)) trialMark("error", parsed?.error?.code ?? String(response.status));
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
  /** The modules the Console allows, on or off (K-01): Admin → Kitchen shows only where Kitchen is allowed. */
  readonly modules_allowed?: readonly ModuleId[];
  readonly permissions: readonly Action[];
  /** Can also open (P-10): the Admin sections the owner gave this person on top of their role. */
  readonly admin_sections?: readonly string[];
  /** Training mode (M7-03): the person or this device; the shell shows the band. */
  readonly training?: boolean;
  /** Set up your venue (O-02): "pending" on a venue made in our Console until Finish setup. */
  readonly setup?: "pending" | null;
  /** The side menu's order (P-13), the venue's: entry ids first to last; empty is the app's own. */
  readonly menu_order?: readonly string[];
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
