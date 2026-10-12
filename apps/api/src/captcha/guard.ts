import { createHmac, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { readSetting, type Queryable } from "@west4/db";
import { businessDate, dailyLimitHit, formLimits } from "@west4/rules";
import type { PublicForm, Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { loadTrustedProxyHops, publicIpOf } from "../router/ip-owner.js";
import type { CaptchaVerifier } from "./turnstile.js";

/**
 * The public forms' guard (M2-27, D109; Security 8), one place for every
 * public form: the waitlist join from the door QR and every phone-code send
 * (a staff invite, a singer) now; a booking hold and an enquiry with M5-05.
 *
 *   1. `split` takes `captcha_token` out of the body, so each route's own
 *      strict schema reads the rest.
 *   2. `check`, before any transaction: the token goes to Turnstile's
 *      siteverify, and the request is named by its IP address and device
 *      (a long-lived random cookie, set here when missing).
 *   3. `use`, inside the venue's transaction that makes the thing: today's
 *      accepted uses of the form, per phone number, IP address and device,
 *      against the venue's daily limits (Admin → Spam protection); past one
 *      it refuses, otherwise it records this use. "Today" is the venue's
 *      business date, so the limits start again at the cutover.
 *
 * The phone number, IP address and device are stored only as keyed hashes.
 */
export const DEVICE_COOKIE = "west4_device";
const DEVICE_COOKIE_DAYS = 365;

/** The forms as the table names them. */
const FORM_ROW: Record<PublicForm, string> = {
  waitlist: "waitlist",
  phoneCode: "phone_code",
};

export interface FormCaller {
  readonly ipHash: string;
  readonly deviceHash: string | null;
}

export interface PublicFormGuard {
  split(body: unknown): { token: string; body: unknown };
  check(request: FastifyRequest, reply: FastifyReply, token: string): Promise<FormCaller>;
  use(
    c: Queryable,
    venueId: string,
    form: PublicForm,
    caller: FormCaller,
    who: { phoneE164: string | null; subjectId?: string | null },
    now: Temporal.Instant,
  ): Promise<void>;
}

export function makePublicFormGuard(options: {
  verify: CaptchaVerifier;
  secretKey: Buffer;
  cookieSecure: boolean;
  cookieSameSite: "Lax" | "None" | "Strict";
}): PublicFormGuard {
  const proxyHops = loadTrustedProxyHops();
  const hash = (kind: string, value: string) =>
    createHmac("sha256", options.secretKey).update(`public-form:${kind}:${value}`).digest("hex");

  const deviceOf = (request: FastifyRequest, reply: FastifyReply): string => {
    const cookie = request.headers.cookie;
    if (typeof cookie === "string") {
      for (const part of cookie.split(";")) {
        const eq = part.indexOf("=");
        if (eq > 0 && part.slice(0, eq).trim() === DEVICE_COOKIE) {
          const v = part.slice(eq + 1).trim();
          if (/^[A-Za-z0-9_-]{22}$/.test(v)) return v;
        }
      }
    }
    const id = randomBytes(16).toString("base64url");
    const parts = [
      `${DEVICE_COOKIE}=${id}`,
      "Path=/v1/",
      "HttpOnly",
      `SameSite=${options.cookieSameSite}`,
      `Max-Age=${DEVICE_COOKIE_DAYS * 24 * 3600}`,
    ];
    if (options.cookieSecure || options.cookieSameSite === "None") parts.push("Secure");
    reply.header("Set-Cookie", parts.join("; "));
    return id;
  };

  return {
    split(body) {
      if (!body || typeof body !== "object" || Array.isArray(body)) return { token: "", body };
      const { captcha_token: token, ...rest } = body as Record<string, unknown>;
      return { token: typeof token === "string" ? token : "", body: rest };
    },

    async check(request, reply, token) {
      const ip = publicIpOf(request.ip, request.headers["x-forwarded-for"], proxyHops);
      const device = deviceOf(request, reply);
      const result = await options.verify(token, ip || null);
      if (!result.ok) {
        if (result.unavailable)
          throw new ApiError(
            "captcha_unavailable",
            "the security check couldn't be confirmed; try again",
            {
              details: { reason: "captcha_unavailable" },
            },
          );
        throw new ApiError("captcha_failed", "the security check didn't pass; try it again", {
          details: { reason: "captcha" },
        });
      }
      return {
        ipHash: hash("ip", ip),
        deviceHash: hash("device", device),
      };
    },

    async use(c, venueId, form, caller, who, now) {
      const venue = await c.query<{ time_zone: string; day_cutover: string }>(
        "select time_zone, to_char(day_cutover, 'HH24:MI') as day_cutover from venues where id = $1",
        [venueId],
      );
      const v = venue.rows[0];
      if (!v) throw new ApiError("not_found", "no such venue");
      const date = businessDate(now, v.time_zone, v.day_cutover).businessDate;
      const limits = formLimits((await readSetting(c, venueId, "publicForms", date))?.value, form);
      const phoneHash = who.phoneE164 ? hash("phone", who.phoneE164) : null;
      // One form's uses at a venue are counted one at a time, so two at once can't both take the last place.
      await c.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `public-form:${venueId}:${form}`,
      ]);
      const counts = await c.query<{ phone: number; ip: number; device: number }>(
        `select count(*) filter (where phone_hash = $4)::int as phone,
                count(*) filter (where ip_hash = $5)::int as ip,
                count(*) filter (where device_hash = $6)::int as device
           from public_form_uses
          where venue_id = $1 and form = $2 and counted_on = $3`,
        [venueId, FORM_ROW[form], date.toString(), phoneHash, caller.ipHash, caller.deviceHash],
      );
      const n = counts.rows[0]!;
      const hit = dailyLimitHit(
        {
          phone: phoneHash ? n.phone : null,
          ip: n.ip,
          device: caller.deviceHash ? n.device : null,
        },
        limits,
      );
      if (hit)
        throw new ApiError(
          "daily_limit",
          `today's limit for this ${hit === "ip" ? "network" : hit} is reached`,
          {
            details: { reason: "daily_limit", limit: hit },
          },
        );
      await c.query(
        `insert into public_form_uses (venue_id, form, counted_on, phone_hash, ip_hash, device_hash, subject_id)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          venueId,
          FORM_ROW[form],
          date.toString(),
          phoneHash,
          caller.ipHash,
          caller.deviceHash,
          who.subjectId ?? null,
        ],
      );
    },
  };
}
