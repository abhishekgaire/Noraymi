import type { FastifyInstance } from "fastify";
import type { RegisteredRoute } from "../http/registry.js";
import {
  PARAM_SAMPLES,
  cast,
  declaredFor,
  fillUrl,
  inject,
  isAdminRoute,
  type Cast,
} from "./fixtures.js";

/**
 * The principal suite (M1-37; spec 02 · Who can call what): every route in
 * the registry, called as every principal. A principal the route doesn't
 * declare must get 401 or 403, whatever else is wrong with the call. And no
 * PIN or badge session reaches an Admin route (assurance passkey, or an
 * `admin.*` action), even when its role is declared.
 */
export interface PrincipalRow {
  readonly route: string;
  readonly principal: string;
  readonly declared: boolean;
  readonly status: number;
}

export interface PrincipalFinding {
  readonly route: string;
  readonly principal: string;
  readonly status: number;
  readonly why: string;
}

export interface PrincipalSuiteResult {
  readonly rows: PrincipalRow[];
  readonly findings: PrincipalFinding[];
  /** The generated Admin assertions: one line per Admin route × PIN or badge session. */
  readonly adminAssertions: string[];
  readonly skipped: string[];
}

const DENIED = new Set([401, 403]);

export async function runPrincipalSuite(
  app: FastifyInstance & { routes: RegisteredRoute[] },
  c: Cast,
): Promise<PrincipalSuiteResult> {
  const rows: PrincipalRow[] = [];
  const findings: PrincipalFinding[] = [];
  const adminAssertions: string[] = [];
  const skipped: string[] = [];
  const values = { ...PARAM_SAMPLES, venueId: c.venueA };
  for (const route of app.routes) {
    const label = `${route.method} ${route.url}`;
    if (route.websocket) {
      skipped.push(`${label} (WebSocket: covered by the events tests)`);
      continue;
    }
    const { url, missing } = fillUrl(route.url, values);
    if (missing.length > 0) {
      findings.push({
        route: label,
        principal: "-",
        status: 0,
        why: `no sample for :${missing.join(", :")} in PARAM_SAMPLES (apps/api/src/security/fixtures.ts)`,
      });
      continue;
    }
    for (const { name, principal } of cast(c)) {
      const declared = declaredFor(route, principal, c.venueA);
      const r = await inject(app, route, url, principal);
      rows.push({ route: label, principal: name, declared, status: r.statusCode });
      if (!declared && !DENIED.has(r.statusCode)) {
        findings.push({
          route: label,
          principal: name,
          status: r.statusCode,
          why: "not declared for this principal, yet the answer wasn't 401 or 403",
        });
      }
      const pinOrBadge =
        principal.kind === "user" && (principal.session === "pin" || principal.session === "badge");
      if (isAdminRoute(route) && pinOrBadge) {
        adminAssertions.push(`${label} as ${name} → ${r.statusCode}`);
        if (r.statusCode !== 403)
          findings.push({
            route: label,
            principal: name,
            status: r.statusCode,
            why: "an Admin route answered a PIN or badge session with something other than 403",
          });
      }
    }
  }
  return { rows, findings, adminAssertions, skipped };
}
