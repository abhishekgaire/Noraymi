/**
 * Where the browser tests find each server and the database: one module, so
 * no spec hard-codes a port.
 *
 * By default the tests use the usual local ports (API 3000, guest 3001, staff
 * 5173, console 5174, fake Stripe 12111, fake Google 12112) and the `west4`
 * database, and reuse servers already running there.
 *
 * E2E_ISOLATED=1 (`pnpm e2e:isolated`) gives the run a stack of its own, so a
 * demo running on the usual ports is never reseeded or signed out:
 *   - its own database, E2E_DATABASE (default `west4_e2e`), created and migrated if missing;
 *   - its own ports from E2E_PORT_BASE (default 13000): API base, guest +1,
 *     staff +2, console +3, fake Stripe +11, fake Google +12, design canvas +20;
 *   - its own servers, always started fresh (never reused).
 */
const env = process.env;

export const isolated = env["E2E_ISOLATED"] === "1" || env["E2E_ISOLATED"] === "true";

const base = Number(env["E2E_PORT_BASE"] ?? 13000);

export const ports = isolated
  ? {
      api: base,
      guest: base + 1,
      staff: base + 2,
      console: base + 3,
      stripe: base + 11,
      google: base + 12,
      canvas: Number(env["DESIGN_REVIEW_CANVAS_PORT"] ?? base + 20),
    }
  : {
      api: 3000,
      guest: 3001,
      staff: 5173,
      console: 5174,
      stripe: 12111,
      google: 12112,
      canvas: Number(env["DESIGN_REVIEW_CANVAS_PORT"] ?? 8765),
    };

const dbName = isolated ? (env["E2E_DATABASE"] ?? "west4_e2e") : "west4";

/** The table owner (migrations, seed, direct reads in the specs). In isolated mode DATABASE_URL is ignored. */
export const DB =
  (isolated ? undefined : env["DATABASE_URL"]) ?? `postgres://west4:west4@localhost:5432/${dbName}`;
/** What the API connects as. */
export const APP_DB =
  (isolated ? undefined : env["APP_DATABASE_URL"]) ??
  `postgres://app_rw:app_rw@localhost:5432/${dbName}`;

/** The API, as the tests call it directly. */
export const API = `http://127.0.0.1:${ports.api}`;
/** The API on the `localhost` name (its own origin for passkeys). */
export const API_LOCAL = `http://localhost:${ports.api}`;
export const STAFF = `http://localhost:${ports.staff}`;
export const CONSOLE = `http://localhost:${ports.console}`;
export const GUEST = `http://localhost:${ports.guest}`;
/** The guest web's payment host. */
export const PAY_HOST = `pay.localhost:${ports.guest}`;
export const PAY = `http://${PAY_HOST}`;
export const STRIPE = `http://127.0.0.1:${ports.stripe}`;
export const GOOGLE = `http://127.0.0.1:${ports.google}`;
export const CANVAS = `http://localhost:${ports.canvas}`;

// Every command a spec runs (the seed loader, the Stripe and file seeds) inherits the process's
// environment, so in isolated mode it points at this stack, never at the demo's database or fakes.
if (isolated) {
  Object.assign(process.env, {
    DATABASE_URL: DB,
    APP_DATABASE_URL: APP_DB,
    STRIPE_API_BASE: STRIPE,
    GOOGLE_API_BASE: GOOGLE,
    DESIGN_REVIEW_CANVAS_PORT: String(ports.canvas),
  });
}

/** A string made safe to put inside a RegExp. */
export function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
