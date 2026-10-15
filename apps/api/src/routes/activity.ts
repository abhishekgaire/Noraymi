import type { FastifyInstance, FastifyRequest } from "fastify";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";

/**
 * Activity log and About (P-14; spec 12 · 4, spec 02 · Audit rows):
 *   GET /v1/venues/{v}/activity   Admin → Activity log, the owner's: the venue's own audit rows, newest
 *                                 first, 50 at a time (?before=<id>), filtered by ?person=<user id|system>,
 *                                 ?kind=<record kind> and ?from= / ?to= (business dates). Personal data is
 *                                 masked the way the masked views mask it (phone numbers to their last two
 *                                 digits, emails to their first letter and domain, guest names to initials),
 *                                 and anything secret (PIN verifiers, tokens, keys, hashes, card details, ID
 *                                 scans, message bodies) never leaves the server, only the field's name.
 *   GET /v1/venues/{v}/about      Admin → About, owners and managers: the venue's id and name, the server's
 *                                 version, and our support contact (SUPPORT_EMAIL, SUPPORT_PHONE; null
 *                                 while unset, never invented).
 */

const PAGE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KIND = /^[a-z][a-z0-9_]{0,62}$/;

/** A field whose value never shows, only its name: secrets, card details, ID scans, message bodies. */
const SECRET =
  /(^|_)(pin|pins|verifier|token|tokens|secret|password|hash|hashes|key|keys|credential|cookie|signature|otp|fingerprint|wrapped|enc|cipher|ip|ua|last4|scanned|dob|birth|body|cvc|cvv|pan|iban|routing)(_|$)/;
/** Guest name fields, shown as initials. */
const GUEST_NAME_KEYS = new Set(["guest_name", "card_name", "claimed_by_name", "tab_name"]);
const GUEST_TABLES = new Set([
  "guests",
  "room_guests",
  "tabs",
  "tab_openings",
  "singers",
  "bookings",
  "waitlist_entries",
]);
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const EMAIL_IN = /[^\s@"',;<>]+@[^\s@"',;<>]+\.[a-z]{2,}/gi;
const PHONE = /^\+?[0-9][0-9 ().-]{7,}[0-9]$/;

export const HIDDEN = "•••";

export const maskEmail = (email: string) => {
  const [user = "", domain = ""] = email.split("@");
  return `${user.slice(0, 1)}•••@${domain}`;
};
export const maskPhone = (phone: string) => `••• ••• ${phone.replace(/\D/g, "").slice(-2)}`;
export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `${w.slice(0, 1).toUpperCase()}.`)
    .join(" ") || HIDDEN;

export const isSecretField = (key: string) => SECRET.test(key.toLowerCase());

const isGuestName = (table: string, key: string) =>
  GUEST_NAME_KEYS.has(key) ||
  /^rep_(first|last)_name$/.test(key) ||
  (GUEST_TABLES.has(table) && (key === "name" || key === "display_name"));

function maskString(key: string, value: string): string {
  const k = key.toLowerCase();
  if (k.includes("email") || EMAIL.test(value))
    return EMAIL.test(value) ? maskEmail(value) : HIDDEN;
  if (k.includes("phone") || (PHONE.test(value) && value.replace(/\D/g, "").length >= 10))
    return maskPhone(value);
  return value.replace(EMAIL_IN, (m) => maskEmail(m));
}

/** One audited value as the Activity log shows it; `table` is the record's kind. */
export function maskValue(table: string, key: string, value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (isSecretField(key)) return HIDDEN;
  if (isGuestName(table, key) && typeof value === "string") return initials(value);
  if (typeof value === "string") return maskString(key, value);
  if (Array.isArray(value)) return value.map((v) => maskValue(table, key, v));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, maskValue(table, k, v)]),
    );
  }
  return value;
}

export interface ActivityChange {
  readonly field: string;
  /** True when the value is withheld: written without it (guest contact details) or secret here. */
  readonly hidden: boolean;
  readonly old: unknown;
  readonly new: unknown;
}

export interface ActivityRow {
  readonly id: string;
  readonly at: string;
  readonly business_date: string;
  readonly actor: { readonly user_id: string; readonly name: string | null } | null;
  readonly support: boolean;
  readonly kind: string;
  readonly op: "insert" | "update" | "delete" | string;
  readonly record_id: string;
  readonly changes: readonly ActivityChange[];
}

interface DbRow {
  id: string;
  at: Date;
  business_date: string;
  actor: string | null;
  actor_name: string | null;
  support_grant_id: string | null;
  emergency: boolean;
  action: string;
  target: string;
  changed_fields: string[];
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
}

export function activityRow(r: DbRow): ActivityRow {
  const dot = r.action.lastIndexOf(".");
  const kind = dot > 0 ? r.action.slice(0, dot) : r.action;
  const op = dot > 0 ? r.action.slice(dot + 1) : "";
  const slash = r.target.indexOf("/");
  const changes = r.changed_fields.map((field): ActivityChange => {
    const inOld = r.old_values !== null && field in r.old_values;
    const inNew = r.new_values !== null && field in r.new_values;
    const withheld = (r.old_values !== null && !inOld) || (r.new_values !== null && !inNew);
    if (withheld || isSecretField(field)) return { field, hidden: true, old: null, new: null };
    return {
      field,
      hidden: false,
      old: inOld ? maskValue(kind, field, r.old_values![field]) : null,
      new: inNew ? maskValue(kind, field, r.new_values![field]) : null,
    };
  });
  return {
    id: r.id,
    at: r.at.toISOString(),
    business_date: r.business_date,
    actor: r.actor ? { user_id: r.actor, name: r.actor_name } : null,
    support: r.support_grant_id !== null || r.emergency,
    kind,
    op,
    record_id: slash >= 0 ? r.target.slice(slash + 1) : r.target,
    changes,
  };
}

function ownerOnly(request: FastifyRequest): string {
  const venueId = request.venueId!;
  const p = request.principal;
  const here = p.kind === "user" ? p.memberships.find((m) => m.venueId === venueId) : undefined;
  // Managers come with P-10's per-person access; until then the log is the owner's (the ticket's default).
  if (p.kind !== "user" || here?.role !== "owner")
    throw new ApiError("forbidden", "the activity log is the owner's");
  return venueId;
}

export interface AboutOptions {
  readonly version: string;
  readonly supportEmail: string | null;
  readonly supportPhone: string | null;
}

export function aboutFromEnv(env: NodeJS.ProcessEnv): AboutOptions {
  const val = (k: string) => (env[k] ?? "").trim() || null;
  return {
    version: val("APP_VERSION") ?? "dev",
    supportEmail: val("SUPPORT_EMAIL"),
    supportPhone: val("SUPPORT_PHONE"),
  };
}

export function activityRoutes(app: FastifyInstance, options: { about: AboutOptions }): void {
  const admin = route({
    principals: ["owner_manager"],
    module: "core",
    action: "admin.access",
    assurance: "passkey",
  });

  app.get<{
    Params: { venueId: string };
    Querystring: { before?: string; person?: string; kind?: string; from?: string; to?: string };
  }>("/v1/venues/:venueId/activity", { config: admin }, async (request) => {
    const venueId = ownerOnly(request);
    const q = request.query;
    if (q.before !== undefined && !/^\d{1,18}$/.test(q.before))
      throw new ApiError("invalid_request", "before is a row id");
    if (q.person !== undefined && q.person !== "system" && !UUID.test(q.person))
      throw new ApiError("invalid_request", "person is a user id or system");
    if (q.kind !== undefined && !KIND.test(q.kind))
      throw new ApiError("invalid_request", "kind is a record kind");
    for (const d of [q.from, q.to])
      if (d !== undefined && !DATE.test(d))
        throw new ApiError("invalid_request", "send dates as YYYY-MM-DD");

    return request.inVenue(async (c) => {
      const where = ["a.venue_id = $1"];
      const args: unknown[] = [venueId];
      const add = (sql: string, v: unknown) => {
        args.push(v);
        where.push(sql.replace("?", `$${args.length}`));
      };
      if (q.before) add("a.id < ?::bigint", q.before);
      if (q.person === "system") where.push("a.actor is null");
      else if (q.person) add("a.actor = ?::uuid", q.person);
      if (q.kind) add("split_part(a.action, '.', 1) = ?", q.kind);
      const bd = "((a.at at time zone v.time_zone) - v.day_cutover)::date";
      if (q.from) add(`${bd} >= ?::date`, q.from);
      if (q.to) add(`${bd} <= ?::date`, q.to);
      args.push(PAGE + 1);
      const rows = (
        await c.query<DbRow>(
          `select a.id::text as id, a.at, ${bd}::text as business_date, a.actor, u.name as actor_name,
                  a.support_grant_id, a.emergency_action_id is not null as emergency,
                  a.action, a.target, a.changed_fields, a.old_values, a.new_values
             from audit_log a
             join venues v on v.id = a.venue_id
             left join users u on u.id = a.actor
            where ${where.join(" and ")}
            order by a.id desc
            limit $${args.length}`,
          args,
        )
      ).rows;
      const page = rows.slice(0, PAGE);
      const people = (
        await c.query<{ user_id: string; name: string }>(
          `select u.id as user_id, u.name from memberships m join users u on u.id = m.user_id
            where m.venue_id = $1 order by u.name`,
          [venueId],
        )
      ).rows;
      const kinds = (
        await c.query<{ kind: string }>(
          // The kinds written in the last 90 days (the venue/at index), not a scan of six years.
          `select distinct split_part(action, '.', 1) as kind from audit_log
            where venue_id = $1 and at > now() - interval '90 days' order by 1`,
          [venueId],
        )
      ).rows.map((r) => r.kind);
      return {
        rows: page.map(activityRow),
        next_before: rows.length > PAGE ? page[page.length - 1]!.id : null,
        people,
        kinds,
      };
    });
  });

  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/about",
    { config: admin },
    async (request) => {
      const venueId = request.venueId!;
      const venue = await request.inVenue(
        async (c) =>
          (await c.query<{ name: string }>("select name from venues where id = $1", [venueId]))
            .rows[0],
      );
      if (!venue) throw new ApiError("not_found", "no such venue");
      return {
        venue_id: venueId,
        venue_name: venue.name,
        server_version: options.about.version,
        support: { email: options.about.supportEmail, phone: options.about.supportPhone },
      };
    },
  );
}
