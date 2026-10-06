import type pg from "pg";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { resolveVenueSlug, withVenue, type Queryable } from "@west4/db";
import type { Clock } from "@west4/shared";
import type { AuthConfig } from "../config.js";
import type { Authenticator } from "../http/conventions.js";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import {
  barModeState,
  queueOwnSong,
  queuePage,
  requestSingerCode,
  singerByToken,
  verifySingerCode,
} from "../songs/public.js";

/**
 * Bar mode's public routes (M6-20; API · Bar mode), for the singer's queue page:
 *   POST /v1/public/venues/{slug}/singers         { display_name, phone_e164, locale? }: a code is texted
 *                                                 to the number (always 202, whether or not it's known)
 *   POST /v1/public/venues/{slug}/singers/verify  { phone_e164, code }: the number confirmed once; the
 *                                                 phone gets the singer cookie (a 128-bit token, hashed)
 *   GET  /v1/public/venues/{slug}/queue           who's singing, the next names; with the cookie, the
 *                                                 singer's own songs, place and credits
 *   POST /v1/public/venues/{slug}/queue           { title, artist? } as the singer: a song into the rotation
 *   GET  /v1/public/venues/{slug}/songs?q=        the songbook search: empty until a songbook loads (M6-23)
 * The live channel takes the same cookie: a singer follows `song_queue.updated` on /v1/venues/{v}/events.
 *
 * Not built yet, and joining here when M2-27 lands: the server-checked CAPTCHA and the daily limits on
 * phone codes per number, IP address and device. The provider and the numbers wait on the founder
 * (M2-27, M5-05), so these routes run as the waitlist's door route does today, without them.
 */
export const SINGER_COOKIE = "west4_singer";
const SINGER_COOKIE_HOURS = 24 * 30;

function singerCookieOf(request: FastifyRequest): string | null {
  const cookie = request.headers.cookie;
  if (typeof cookie !== "string") return null;
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === SINGER_COOKIE) {
      const v = decodeURIComponent(part.slice(eq + 1).trim());
      return /^[A-Za-z0-9_-]{20,64}$/.test(v) ? v : null;
    }
  }
  return null;
}

function setSingerCookie(reply: FastifyReply, auth: AuthConfig, token: string): void {
  const parts = [
    `${SINGER_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SINGER_COOKIE_HOURS * 3600}`,
  ];
  if (auth.cookieSecure) parts.push("Secure");
  reply.header("Set-Cookie", parts.join("; "));
}

const PUBLIC_PATH = /^\/v1\/public\/venues\/([^/]+)\/(queue|songs)$/;
const EVENTS_PATH = /^\/v1\/venues\/([0-9a-f-]{36})\/events$/i;

/**
 * The singer authenticator: on the queue page's routes, and on the live channel when no staff session
 * or other credential is on the request, a singer cookie becomes that singer, in the venue it was
 * issued in only.
 */
export function singerAuthenticator(pool: pg.Pool): Authenticator {
  return async (request) => {
    const path = request.url.split("?")[0]!;
    const onPage = PUBLIC_PATH.exec(path);
    const onChannel =
      !onPage &&
      EVENTS_PATH.exec(path) &&
      !request.headers.authorization &&
      !/(^|;\s*)west4_(session|room)=/.test(request.headers.cookie ?? "");
    if (!onPage && !onChannel) return undefined;
    const token = singerCookieOf(request);
    if (!token) return undefined;
    const venueId = onPage
      ? await resolveVenueSlug(pool, decodeURIComponent(onPage[1]!))
      : EVENTS_PATH.exec(path)![1]!;
    if (!venueId) return undefined;
    const singerId = await withVenue(pool, { venueId }, (c) => singerByToken(c, venueId, token));
    if (!singerId) return undefined;
    return { kind: "singer", venueId, singerId };
  };
}

const phone = z.string().regex(/^\+1[2-9]\d{2}[2-9]\d{6}$/);

export function publicSongRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool; clock: Clock; auth: AuthConfig },
): void {
  const open = route({
    principals: ["public"],
    module: "bar_mode",
    idempotency: "none",
    tokenRoute: true,
  });
  const singer = route({
    principals: ["singer"],
    module: "bar_mode",
    idempotency: "none",
    tokenRoute: true,
  });

  /** A public route by slug: bar mode has to be on to join or queue, and not off to read. */
  const inVenue = async <T>(
    request: FastifyRequest<{ Params: { slug: string } }>,
    writes: boolean,
    fn: (c: Queryable, venueId: string) => Promise<T>,
  ): Promise<T> => {
    const venueId = await resolveVenueSlug(options.pool, request.params.slug);
    if (!venueId) throw new ApiError("not_found", "no such venue");
    return withVenue(options.pool, { venueId, requestId: request.requestId }, async (c) => {
      const state = await barModeState(c, venueId);
      if (state === "off" || (writes && state !== "on"))
        throw new ApiError("module_off", "bar mode is off", {
          details: { reason: "bar_mode_off" },
        });
      return fn(c, venueId);
    });
  };
  /** The singer on this request, in this venue. */
  const singerOf = (request: FastifyRequest, venueId: string): string | null =>
    request.principal.kind === "singer" && request.principal.venueId === venueId
      ? request.principal.singerId
      : null;

  const joinBody = z
    .object({
      display_name: z.string().trim().min(1).max(40),
      phone_e164: phone,
      locale: z.enum(["en", "es"]).optional(),
    })
    .strict();
  app.post<{ Params: { slug: string }; Body: unknown }>(
    "/v1/public/venues/:slug/singers",
    { config: open },
    async (request, reply) => {
      const parsed = joinBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError("invalid_request", "send { display_name, phone_e164 } with a US number");
      // M2-27: the server-checked CAPTCHA and the daily limits on phone codes go here, before any text.
      await inVenue(request, true, (c, venueId) =>
        requestSingerCode(c, venueId, {
          displayName: parsed.data.display_name,
          phoneE164: parsed.data.phone_e164,
          locale: parsed.data.locale ?? "en",
          now: options.clock.now(),
        }),
      );
      return reply.code(202).send({ code_sent: true });
    },
  );

  const verifyBody = z.object({ phone_e164: phone, code: z.string().regex(/^\d{6}$/) }).strict();
  app.post<{ Params: { slug: string }; Body: unknown }>(
    "/v1/public/venues/:slug/singers/verify",
    { config: open },
    async (request, reply) => {
      const parsed = verifyBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError("invalid_request", "send { phone_e164, code }: six digits");
      const r = await inVenue(request, true, (c, venueId) =>
        verifySingerCode(c, venueId, {
          phoneE164: parsed.data.phone_e164,
          code: parsed.data.code,
          now: options.clock.now(),
        }),
      );
      // A wrong code is counted, so the count commits before the refusal.
      if ("wrong" in r)
        throw new ApiError("invalid_request", "that code isn't right", {
          details: { reason: "wrong_code", tries_left: r.tries_left },
        });
      setSingerCookie(reply, options.auth, r.token);
      return { confirmed: true };
    },
  );

  app.get<{ Params: { slug: string } }>(
    "/v1/public/venues/:slug/queue",
    { config: open },
    async (request) =>
      inVenue(request, false, (c, venueId) =>
        queuePage(c, venueId, singerOf(request, venueId), options.clock.now()),
      ),
  );

  const songBody = z
    .object({
      title: z.string().trim().min(1).max(120),
      artist: z.string().trim().max(120).nullable().optional(),
    })
    .strict();
  app.post<{ Params: { slug: string }; Body: unknown }>(
    "/v1/public/venues/:slug/queue",
    { config: singer },
    async (request, reply) => {
      const parsed = songBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { title, artist? }");
      const song = await inVenue(request, true, async (c, venueId) => {
        const singerId = singerOf(request, venueId);
        if (!singerId) throw new ApiError("forbidden", "join the queue first");
        return queueOwnSong(c, venueId, {
          singerId,
          title: parsed.data.title,
          artist: parsed.data.artist || null,
          now: options.clock.now(),
        });
      });
      return reply.code(201).send(song);
    },
  );

  // The songbook search. `song_catalog` and its trigram search arrive with the songbook upload (M6-23);
  // until a catalog exists the answer is empty and the page has the singer type a title and artist.
  app.get<{ Params: { slug: string }; Querystring: { q?: string } }>(
    "/v1/public/venues/:slug/songs",
    { config: open },
    async (request) =>
      inVenue(request, false, async () => ({ catalog: false, songs: [] as never[] })),
  );
}
