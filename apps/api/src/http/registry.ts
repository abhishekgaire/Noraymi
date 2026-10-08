import type { FastifyInstance, RouteOptions } from "fastify";
import type { PrincipalName } from "./principal.js";

/**
 * The route registry (spec 08 · Principals). Every route declares who may
 * call it, which module it belongs to and the role action it needs. A route
 * without an entry fails the build; the M1-37 suites read the registry to
 * call every route as every principal.
 */
export interface RouteSpec {
  /** Who may call it. Any other caller gets 403 forbidden. */
  readonly principals: readonly PrincipalName[];
  /** "core" or a module id; a module that's off answers 404 module_off (M1-13). */
  readonly module: string;
  /** The role action (packages/shared roles.ts) checked in role_permissions before a write by a staff caller (M1-14). */
  readonly action?: string;
  /**
   * "passkey": only a passkey session reaches it, never an authenticator, PIN or badge one (spec 02).
   * Every admin.* action and approvals.decide are passkey-only without saying so (M1-19).
   */
  readonly assurance?: "passkey";
  /** A write that asks for the passkey again: large refunds, exports, team changes, card-fee changes. It needs X-Step-Up. */
  readonly stepUp?: boolean;
  /** POST and PATCH take Idempotency-Key; money routes require it. */
  readonly idempotency?: "optional" | "required" | "none";
  /** Token routes send Referrer-Policy: no-referrer and Cache-Control: no-store (spec 12 · 9). */
  readonly tokenRoute?: boolean;
  /** Staff routes are rate-limited per venue (spec 13 · Capacity). */
  readonly rateLimit?: false | { max: number; windowMs: number };
  /** A WebSocket route: a refused caller is closed with code 4403 after the upgrade, never an HTTP 403. */
  readonly websocket?: boolean;
  /** Creates a new booking, tab or waitlist entry: also refused while the module is stopping. */
  readonly createsNewWork?: boolean;
  /** Keeps working whatever is off: guest routes for existing bookings, waitlist spots, receipts and payments. */
  readonly exemptWhenOff?: boolean;
  /** An Admin write that stays open while Admin is read-only over our unpaid plan (M8-15): paying it. */
  readonly openWhenReadOnly?: boolean;
}

export interface RegisteredRoute extends RouteSpec {
  readonly method: string;
  readonly url: string;
}

declare module "fastify" {
  interface FastifyContextConfig {
    route?: RouteSpec;
  }
}

/** Routes that never need an entry: Fastify's own 404 handler and HEAD twins. */
const EXEMPT = new Set(["HEAD"]);

export class UndeclaredRouteError extends Error {
  constructor(readonly routes: readonly string[]) {
    super(
      `routes without a registry entry (declare principals in config.route): ${routes.join(", ")}`,
    );
    this.name = "UndeclaredRouteError";
  }
}

/** Collects every route as it's added and refuses to start with an undeclared one. */
export function installRegistry(app: FastifyInstance): { routes: RegisteredRoute[] } {
  const routes: RegisteredRoute[] = [];
  const undeclared: string[] = [];
  app.addHook("onRoute", (route: RouteOptions) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (EXEMPT.has(method)) continue;
      const spec = route.config?.route;
      if (!spec) {
        undeclared.push(`${method} ${route.url}`);
        continue;
      }
      routes.push({ ...spec, method, url: route.url });
    }
  });
  app.addHook("onReady", async () => {
    if (undeclared.length > 0) throw new UndeclaredRouteError(undeclared);
  });
  return { routes };
}
