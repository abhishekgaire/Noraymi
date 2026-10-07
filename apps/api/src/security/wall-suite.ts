import { MENU_PDF_KIND } from "../jobs/menu-pdf.js";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { TEXT_TRIGGER_KIND } from "../texts/triggers.js";
import { Worker, enqueue, type JobHandler } from "@west4/db";
import type { Clock } from "@west4/shared";
import type { RegisteredRoute } from "../http/registry.js";
import type { Principal } from "../http/principal.js";
import { AUDIT_EXPORT_KIND } from "../jobs/audit-export.js";
import { LICENSE_REMINDER_KIND } from "../licenses/licenses.js";
import { EVENTS_CLEANUP_KIND } from "../jobs/events-cleanup.js";
import { IDEMPOTENCY_CLEANUP_KIND } from "../jobs/idempotency-cleanup.js";
import { EMAIL_SEND_KIND } from "../jobs/send-email.js";
import { TEXT_SEND_KIND } from "../jobs/send-text.js";
import { PUSH_SEND_KIND } from "../push/send-push.js";
import { SINGER_PUSH_KIND } from "../songs/alerts.js";
import { MESSAGE_SEND_KIND } from "../texts/queue.js";
import type { FakePushSender } from "../push/sender.js";
import { PARAM_SAMPLES, fillUrl, inject, type Cast } from "./fixtures.js";

/**
 * The venue-wall suite (M1-37; spec 02 · The database walls). Three parts:
 *
 * Routes: every endpoint under a venue, called as venue A with venue B's ids,
 * answers "not found" (404, or 403 when a step-up or the principal check
 * stops it earlier); called with venue B as the venue, a principal of A is
 * refused. Every route parameter is classed here as venue-owned (a row of B
 * stands in), global (a module id, a settings key, a role) or exempt (routes
 * outside venues: the Console, invites, public links); a parameter with no
 * class is a finding, so a new route can't land without a wall case.
 *
 * Jobs: every job kind in the worker's registry has a wall case: a payload
 * that names venue B's rows, run as venue A, finds nothing; or a declaration
 * that the kind carries no venue-owned ids. A kind without a case is a
 * finding.
 *
 * Webhooks: every route under /v1/hooks needs a case that resolves only its
 * own venue; none exist in M1, and the first one fails here until it has one.
 */
export interface WallFinding {
  readonly where: string;
  readonly why: string;
}

export interface WallRow {
  readonly route: string;
  readonly as: string;
  readonly status: number;
  readonly outcome: "walled" | "inconclusive" | "leak";
}

export interface WallFixtures {
  /** Venue B's rows, by route parameter name. */
  readonly venueOwned: Readonly<Record<string, string>>;
  /** Bodies that get a write past validation to the lookup, by "METHOD url". */
  readonly bodies?: Readonly<Record<string, unknown>>;
}

const GLOBAL_PARAMS = new Set(["id", "key", "role", "action", "flag", "templateKey", "date"]);
const EXEMPT_PREFIXES = [
  "/v1/console/",
  "/v1/invites/",
  "/v1/public/",
  "/v1/print/", // a printer's own credential names its venue; it sees only its own jobs (print.int.test.ts)
  "/v1/auth/",
  "/v1/devices/",
  "/v1/push/", // the public VAPID key
  "/v1/hooks/", // webhooks resolve their own venue; each has a case in webhookWallCases below
  "/v1/health",
  "/v1/ops/",
];
const WALLED = new Set([403, 404]);
const OPENED = new Set([200, 201, 202, 204]);

/** The principal a route is for, at venue A. */
export function principalFor(
  route: RegisteredRoute,
  c: Cast,
): { as: string; principal: Principal } {
  const user = (
    role: "owner" | "bartender",
    ids: { userId: string; membershipId: string },
    session: "passkey" | "pin",
  ): Principal => ({
    kind: "user",
    userId: ids.userId,
    session,
    memberships: [{ venueId: c.venueA, membershipId: ids.membershipId, role }],
  });
  const device = (
    deviceKind: "bar_computer" | "room_tablet" | "printer" | "up_next_display",
  ): Principal => ({
    kind: "device",
    deviceId: "00000000-0000-4000-8000-000000000001",
    venueId: c.venueA,
    deviceKind,
  });
  const guest = (scope: "room_session" | "booking" | "link"): Principal => ({
    kind: "guest",
    venueId: c.venueA,
    scope,
    id: "00000000-0000-4000-8000-000000000003",
  });
  for (const name of route.principals) {
    switch (name) {
      case "owner_manager":
        return {
          as: "venue A's owner",
          principal: user("owner", { userId: c.ownerA, membershipId: c.membershipA }, "passkey"),
        };
      case "staff":
        return { as: "venue A's bartender", principal: user("bartender", c.bartenderA, "pin") };
      case "shared_device":
        return { as: "venue A's bar computer", principal: device("bar_computer") };
      case "room_tablet":
        return { as: "venue A's room tablet", principal: device("room_tablet") };
      case "printer":
        return { as: "venue A's printer", principal: device("printer") };
      case "up_next_display":
        return { as: "venue A's Up next display", principal: device("up_next_display") };
      case "guest_room":
        return { as: "a guest in venue A's room", principal: guest("room_session") };
      case "guest_booking":
        return { as: "a guest with a venue A booking", principal: guest("booking") };
      case "guest_link":
        return { as: "a guest with a venue A link", principal: guest("link") };
      case "singer":
        return {
          as: "a singer at venue A",
          principal: {
            kind: "singer",
            venueId: c.venueA,
            singerId: "00000000-0000-4000-8000-000000000007",
          },
        };
      case "support":
        return {
          as: "support at venue A",
          principal: {
            kind: "support",
            staffId: "00000000-0000-4000-8000-000000000010",
            grantId: "00000000-0000-4000-8000-000000000011",
            venueId: c.venueA,
          },
        };
      case "console":
        return {
          as: "our staff in the Console",
          principal: {
            kind: "console",
            staffId: "00000000-0000-4000-8000-000000000012",
            name: "Sam",
            email: "sam@noraymi.test",
          },
        };
      case "webhook":
        return { as: "a webhook", principal: { kind: "webhook", provider: "stripe" } };
      case "public":
        return { as: "nobody", principal: { kind: "anonymous" } };
    }
  }
  return { as: "nobody", principal: { kind: "anonymous" } };
}

export async function runRouteWalls(
  app: FastifyInstance & { routes: RegisteredRoute[] },
  c: Cast,
  fixtures: WallFixtures,
): Promise<{ rows: WallRow[]; findings: WallFinding[] }> {
  const rows: WallRow[] = [];
  const findings: WallFinding[] = [];
  for (const route of app.routes) {
    const label = `${route.method} ${route.url}`;
    if (route.websocket) continue;
    if (EXEMPT_PREFIXES.some((p) => route.url.startsWith(p))) continue;
    if (!route.url.includes(":venueId")) {
      findings.push({
        where: label,
        why: "a route outside /v1/venues/:venueId that isn't in the exempt list",
      });
      continue;
    }
    const params = [...route.url.matchAll(/:([A-Za-z_]+)/g)]
      .map((m) => m[1]!)
      .filter((p) => p !== "venueId");
    const { as, principal } = principalFor(route, c);
    const body = fixtures.bodies?.[label];

    // Venue B's rows, as venue A.
    const owned = params.filter((p) => !GLOBAL_PARAMS.has(p));
    for (const p of owned) {
      if (fixtures.venueOwned[p] === undefined) {
        findings.push({
          where: label,
          why: `no wall case for :${p}: add venue B's row to the suite's fixtures, or class the parameter`,
        });
      }
    }
    if (owned.length > 0 && owned.every((p) => fixtures.venueOwned[p] !== undefined)) {
      const values = { ...PARAM_SAMPLES, venueId: c.venueA, ...fixtures.venueOwned };
      const { url } = fillUrl(route.url, values);
      const r = await inject(app, route, url, principal, body);
      const outcome = OPENED.has(r.statusCode)
        ? "leak"
        : WALLED.has(r.statusCode)
          ? "walled"
          : "inconclusive";
      rows.push({
        route: `${label} with venue B's :${owned.join(", :")}`,
        as,
        status: r.statusCode,
        outcome,
      });
      if (outcome === "leak")
        findings.push({ where: label, why: `venue B's row answered ${r.statusCode} to ${as}` });
      if (outcome === "inconclusive")
        findings.push({
          where: label,
          why: `answered ${r.statusCode} before reaching the lookup: give the suite a body for it (fixtures.bodies)`,
        });
    }

    // Venue B as the venue, with a principal of A.
    if (!route.principals.includes("public") && !route.principals.includes("console")) {
      const { url } = fillUrl(route.url, {
        ...PARAM_SAMPLES,
        venueId: c.venueB,
        ...fixtures.venueOwned,
      });
      const r = await inject(app, route, url, principal, body);
      const outcome = OPENED.has(r.statusCode)
        ? "leak"
        : [401, 403, 404].includes(r.statusCode)
          ? "walled"
          : "inconclusive";
      rows.push({ route: `${label} at venue B`, as, status: r.statusCode, outcome });
      if (outcome !== "walled")
        findings.push({ where: label, why: `venue B answered ${r.statusCode} to ${as}` });
    }
  }
  return { rows, findings };
}

/** A job kind's wall case. */
export type JobWallCase =
  | { readonly carries: "no venue-owned ids"; readonly why: string }
  | {
      readonly carries: "venue B's ids";
      readonly pool: "critical" | "normal" | "bulk";
      readonly payload: (c: Cast & { ownerB: string }) => unknown;
      /** What "finds nothing" looks like after the worker ran it as venue A. */
      readonly expect: (
        job: { status: string; last_error: string | null },
        senders: { push: FakePushSender },
      ) => string | null;
    };

export const jobWallCases: Readonly<Record<string, JobWallCase>> = {
  [MENU_PDF_KIND]: {
    carries: "no venue-owned ids",
    why: "an empty payload: the venue comes from the job row, and the menu is read in its context",
  },
  [EMAIL_SEND_KIND]: { carries: "no venue-owned ids", why: "an address, a template and its words" },
  [TEXT_SEND_KIND]: {
    carries: "no venue-owned ids",
    why: "a phone number, a template and its words",
  },
  [PUSH_SEND_KIND]: {
    carries: "venue B's ids",
    pool: "normal",
    payload: (c) => ({
      audience: { kind: "person", user_id: c.ownerB },
      message: { key: "setup.testSent" },
    }),
    expect: (job, { push }) =>
      job.status !== "done"
        ? `the push job didn't finish: ${job.last_error ?? job.status}`
        : push.sent.length > 0
          ? `a push went out for venue B's person from venue A`
          : null,
  },
  [AUDIT_EXPORT_KIND]: {
    carries: "venue B's ids",
    pool: "bulk",
    payload: (c) => ({ venue_id: c.venueB, business_date: "2026-09-25" }),
    // The handler takes its venue from the job row, never the payload, and runs inside venue A's
    // context: venue B's id in the payload changes nothing, and the job finishes on A alone.
    expect: (job) =>
      job.status === "done"
        ? null
        : `the audit export didn't finish on venue A alone (${job.status}: ${job.last_error ?? "no error"})`,
  },
  [LICENSE_REMINDER_KIND]: {
    carries: "venue B's ids",
    pool: "bulk",
    payload: (c) => ({ venue_id: c.venueB }),
    // The venue comes from the job row: venue B's id in the payload changes nothing, and its
    // license (expiring within 30 days of the seed's date) is never reminded from venue A.
    expect: (job) =>
      job.status === "done"
        ? null
        : `the license reminders didn't finish on venue A alone (${job.status}: ${job.last_error ?? "no error"})`,
  },
  [MESSAGE_SEND_KIND]: {
    carries: "venue B's ids",
    pool: "normal",
    payload: (c) => ({ message_id: (c as unknown as { messageB: string }).messageB }),
    expect: (job) =>
      job.status === "done"
        ? null
        : `the guest text job didn't finish quietly on venue A (${job.status}: ${job.last_error ?? "no error"})`,
  },
  [TEXT_TRIGGER_KIND]: {
    carries: "venue B's ids",
    pool: "normal",
    payload: (c) => ({
      template_key: "room_ready",
      to: "+12125550188",
      params: { room: "Room 1" },
      guest_id: (c as unknown as { guestB: string }).guestB,
      context: { kind: "session", id: (c as unknown as { sessionB: string }).sessionB },
    }),
    // Venue B's guest and session aren't venue A's: the trigger sends nothing and finishes.
    expect: (job) =>
      job.status === "done"
        ? null
        : `the text trigger didn't finish quietly on venue A (${job.status}: ${job.last_error ?? "no error"})`,
  },
  [SINGER_PUSH_KIND]: {
    carries: "venue B's ids",
    pool: "normal",
    payload: (c) => {
      const b = c as unknown as { singerB: string; songB: string };
      return { singer_id: b.singerB, queue_id: b.songB, alert: "up_next", count: 0 };
    },
    // Venue B's singer and song aren't venue A's: no push goes to singer B's phone, and the job finishes.
    expect: (job, { push }) =>
      job.status !== "done"
        ? `the singer alert didn't finish quietly on venue A (${job.status}: ${job.last_error ?? "no error"})`
        : push.sent.length > 0
          ? "a singer alert went to venue B's singer from venue A"
          : null,
  },
  [IDEMPOTENCY_CLEANUP_KIND]: { carries: "no venue-owned ids", why: "a platform sweep by age" },
  [EVENTS_CLEANUP_KIND]: { carries: "no venue-owned ids", why: "a platform sweep by age" },
};

export async function runJobWalls(
  owner: pg.Pool,
  handlers: Record<"critical" | "normal" | "bulk", Record<string, JobHandler>>,
  clock: Clock,
  c: Cast & { ownerB: string; messageB?: string },
  senders: { push: FakePushSender },
): Promise<{ rows: string[]; findings: WallFinding[] }> {
  const rows: string[] = [];
  const findings: WallFinding[] = [];
  for (const pool of ["critical", "normal", "bulk"] as const) {
    for (const kind of Object.keys(handlers[pool])) {
      const wallCase = jobWallCases[kind];
      if (!wallCase) {
        findings.push({
          where: `job ${kind}`,
          why: "no wall case in jobWallCases (apps/api/src/security/wall-suite.ts)",
        });
        continue;
      }
      if (wallCase.carries === "no venue-owned ids") {
        rows.push(`job ${kind}: carries no venue-owned ids (${wallCase.why})`);
        continue;
      }
      const id = await enqueue(owner, {
        venueId: c.venueA,
        kind,
        pool,
        runAt: clock.now(),
        payload: wallCase.payload(c),
      });
      const worker = new Worker(owner, { pool, handlers: handlers[pool], clock });
      await worker.tick();
      const job = (
        await owner.query<{ status: string; last_error: string | null }>(
          "select status, last_error from jobs where id = $1",
          [id],
        )
      ).rows[0]!;
      const problem = wallCase.expect(job, senders);
      rows.push(`job ${kind} for venue A with venue B's ids: ${problem ?? "found nothing"}`);
      if (problem) findings.push({ where: `job ${kind}`, why: problem });
    }
  }
  return { rows, findings };
}

/** Webhook routes resolve only their own venue; each needs a case here once it lands (M2, M4). */
export const webhookWallCases: Readonly<Record<string, string>> = {
  // Resolved by the subaccount, signed with that venue's token, and applied only to that venue's messages:
  // apps/api/src/routes/twilio-hooks.int.test.ts sends venue B's message SID from venue A's account and sees nothing move.
  "POST /v1/hooks/twilio/status": "twilio-hooks.int.test.ts · another venue's message never moves",
  // Resolved by the number texted, signed with that venue's token: inbox.int.test.ts sends to West 4's number with
  // another venue's token (refused) and to the other venue's number (lands only there).
  "POST /v1/hooks/twilio":
    "inbox.int.test.ts · another venue's number and token never reach West 4's inbox",
  // Stripe (M4-03): signed with the endpoint's own secret; the venue comes only from event.account through
  // resolve_stripe_account, and the job runs under that venue. stripe-hooks.int.test.ts sends another
  // organization's account and sees the event and its job land at that venue, never West 4.
  "POST /v1/hooks/stripe/readers":
    "stripe-hooks.int.test.ts · an event from another venue's account never reads or writes West 4's rows",
  "POST /v1/hooks/stripe/connect":
    "stripe-hooks.int.test.ts · an event from another venue's account never reads or writes West 4's rows",
  // Training mode's sandbox (M7-04): its own secret, test-mode events only, and the venue only from the
  // organization's sandbox account (stripe_training_account_id); a live account's id there names no venue.
  "POST /v1/hooks/stripe/training":
    "training-stripe.int.test.ts · the sandbox's events land only at the training endpoint, and only on practice payments",
  // Our own account's billing events carry no venue: stored with venue_id null, which no venue can read.
  "POST /v1/hooks/stripe/platform":
    "stripe-hooks.int.test.ts · keep our own account's billing events, unprocessed, for M8",
};

export function checkWebhooks(routes: readonly RegisteredRoute[]): WallFinding[] {
  return routes
    .filter((r) => r.url.startsWith("/v1/hooks/"))
    .filter((r) => !webhookWallCases[`${r.method} ${r.url}`])
    .map((r) => ({
      where: `${r.method} ${r.url}`,
      why: "no webhook wall case in webhookWallCases",
    }));
}
