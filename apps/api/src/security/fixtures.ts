import type { FastifyInstance } from "fastify";
import type { RegisteredRoute } from "../http/registry.js";
import { ANONYMOUS, principalIs, type Principal } from "../http/principal.js";

/**
 * The cast for the security suites (M1-37; spec 02 · Who can call what, spec
 * 13 · Tests). Every principal the spec names, built straight as a Principal
 * and handed to the app through the `x-test-principal` header, so the suites
 * exercise the conventions' checks, not the sign-in flows (those have their
 * own tests). The host isn't a principal of its own yet (the guest in the room
 * carries the host's rights in M1); the entry stays so the list reads like
 * the spec and a later milestone fills it in.
 */
export interface Cast {
  readonly venueA: string;
  readonly venueB: string;
  readonly ownerA: string;
  readonly membershipA: string;
  readonly managerA: { userId: string; membershipId: string };
  readonly bartenderA: { userId: string; membershipId: string };
  readonly frontDeskA: { userId: string; membershipId: string };
}

export interface NamedPrincipal {
  readonly name: string;
  readonly principal: Principal;
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export function cast(c: Cast): NamedPrincipal[] {
  const user = (
    role: "owner" | "manager" | "bartender" | "front_desk",
    session: "passkey" | "authenticator" | "pin" | "badge",
    ids: { userId: string; membershipId: string },
  ): Principal => ({
    kind: "user",
    userId: ids.userId,
    session,
    memberships: [{ venueId: c.venueA, membershipId: ids.membershipId, role }],
  });
  const device = (
    deviceKind: "bar_computer" | "front_desk" | "room_tablet" | "printer" | "up_next_display",
    n: number,
  ): Principal => ({ kind: "device", deviceId: uuid(n), venueId: c.venueA, deviceKind });
  const owner = { userId: c.ownerA, membershipId: c.membershipA };
  return [
    { name: "nobody", principal: ANONYMOUS },
    { name: "an owner in a passkey session", principal: user("owner", "passkey", owner) },
    {
      name: "an owner in an authenticator session",
      principal: user("owner", "authenticator", owner),
    },
    { name: "a manager", principal: user("manager", "passkey", c.managerA) },
    {
      name: "staff with a PIN on a shared device",
      principal: user("bartender", "pin", c.bartenderA),
    },
    { name: "a badge session", principal: user("bartender", "badge", c.bartenderA) },
    { name: "a shared device with nobody signed in", principal: device("bar_computer", 1) },
    {
      name: "staff with a PIN on their own phone",
      principal: user("front_desk", "pin", c.frontDeskA),
    },
    { name: "a room tablet", principal: device("room_tablet", 2) },
    {
      name: "a guest in a room",
      principal: { kind: "guest", venueId: c.venueA, scope: "room_session", id: uuid(3) },
    },
    {
      name: "the host",
      principal: { kind: "guest", venueId: c.venueA, scope: "room_session", id: uuid(4) },
    },
    {
      name: "a guest with a booking",
      principal: { kind: "guest", venueId: c.venueA, scope: "booking", id: uuid(5) },
    },
    {
      name: "a guest with a link",
      principal: { kind: "guest", venueId: c.venueA, scope: "link", id: uuid(6) },
    },
    { name: "a singer", principal: { kind: "singer", venueId: c.venueA, singerId: uuid(7) } },
    { name: "a printer", principal: device("printer", 8) },
    { name: "the Up next display", principal: device("up_next_display", 9) },
    {
      name: "our support staff",
      principal: { kind: "support", staffId: uuid(10), grantId: uuid(11), venueId: c.venueA },
    },
    {
      name: "our staff in the Console",
      principal: { kind: "console", staffId: uuid(12), name: "Sam", email: "sam@noraymi.test" },
    },
    { name: "a webhook", principal: { kind: "webhook", provider: "stripe" } },
  ];
}

/** Sample values for every route parameter the registry knows; a new one must be added here. */
export const PARAM_SAMPLES: Readonly<Record<string, string>> = {
  venueId: "",
  m: uuid(20),
  d: uuid(21),
  b: uuid(22),
  v: uuid(23),
  r: uuid(24),
  bookingId: uuid(25),
  sessionId: uuid(26),
  checkId: uuid(27),
  templateKey: "room_ready",
  id: "rooms",
  key: "hours",
  role: "front_desk",
  action: "pos.use",
  flag: "beta",
  token: "sample-token",
  code: "ABCD",
};

export function fillUrl(
  url: string,
  values: Readonly<Record<string, string>>,
): { url: string; missing: string[] } {
  const missing: string[] = [];
  const filled = url.replace(/:([A-Za-z_]+)/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined) {
      missing.push(name);
      return `:${name}`;
    }
    return value;
  });
  return { url: filled, missing };
}

export function declaredFor(route: RegisteredRoute, p: Principal, venueId?: string): boolean {
  return route.principals.some((name) => principalIs(p, name, venueId));
}

export function isAdminRoute(route: RegisteredRoute): boolean {
  return route.assurance === "passkey" || (route.action ?? "").startsWith("admin.");
}

export const HEADER = "x-test-principal";

export async function inject(
  app: FastifyInstance,
  route: Pick<RegisteredRoute, "method">,
  url: string,
  principal: Principal,
  body?: unknown,
): Promise<{ statusCode: number; body: string }> {
  const write = route.method !== "GET" && route.method !== "HEAD" && route.method !== "OPTIONS";
  return app.inject({
    method: route.method as "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    url,
    headers: {
      [HEADER]: JSON.stringify(principal),
      ...(write ? { "content-type": "application/json", "idempotency-key": `suite-${url}` } : {}),
    },
    ...(write ? { payload: JSON.stringify(body ?? {}) } : {}),
  });
}

/** The test authenticator: the principal the header names, verbatim. */
export const headerAuthenticator = async (request: {
  headers: Record<string, unknown>;
}): Promise<Principal | undefined> => {
  const raw = request.headers[HEADER];
  return typeof raw === "string" ? (JSON.parse(raw) as Principal) : undefined;
};
