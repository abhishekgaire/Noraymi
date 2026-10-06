import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import {
  addSinger,
  buyPrepaidCredits,
  giveSaleCredits,
  moveSong,
  queueSong,
  queueView,
  songMoves,
  verifySinger,
} from "../songs/queue.js";
import { upNextDisplay } from "../songs/public.js";
import { skipSong, startSong, type StartAnswer } from "../songs/start.js";
import { runNow, type PaymentDeps } from "../payments/run.js";
import type { StripeClient } from "../stripe/client.js";

/**
 * Bar mode (M6-18; API · Bar mode), staff side:
 *   GET  /v1/venues/{v}/song-queue                 tonight's queue: who's singing, up next in order with each
 *                                                  singer's credits and flags, the round, songs sung, the singers
 *   GET  /v1/venues/{v}/up-next                    the Up next TV (M6-22), its own device kind only: who's singing,
 *                                                  the next barMode.upNextCount singers and the venue's slug for the
 *                                                  join QR code; names and the song, never a phone number
 *   POST /v1/venues/{v}/song-queue                 { singer_id, title, artist?, catalog_id? }: a song into the rotation
 *   POST /v1/venues/{v}/song-queue/{q}/start       Started (M6-19): the singer before is sung; the song's line posts to
 *                                                  the singer's tab ($0.00 on a drink credit, else the price, growing
 *                                                  the hold), or a credit is spent with no tab; the play log is written
 *   POST /v1/venues/{v}/song-queue/{q}/skip        Skip (M6-19): free; a credit held for the song comes back
 *   POST /v1/venues/{v}/song-queue/{q}/move        { direction: up | down, reason }: a staff move, logged
 *   GET  /v1/venues/{v}/song-queue/{q}/moves       that song's move log: who, which way, when and why
 *   POST /v1/venues/{v}/singers                    + Singer: { display_name, phone_e164, tab_id?, locale? }; a code is texted
 *   POST /v1/venues/{v}/singers/{s}/verify         { code }: the number confirmed once
 *   POST /v1/venues/{v}/singers/{s}/credits        { check_id }: the singer picked on a paid quick sale earns its
 *                                                  drinks' credits; or { prepaid: { count, tendered_cents } }: song
 *                                                  credit bought in cash at the song price (refused with none set)
 * Every change emits song_queue.updated. No answer carries a singer's phone number.
 */
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = z.string().uuid();
const staff = { principals: ["owner_manager", "staff"] as const, module: "bar_mode" };

export function songRoutes(
  app: FastifyInstance,
  options: { clock: Clock; pool: pg.Pool; stripe: () => StripeClient },
): void {
  const deps = (): PaymentDeps => ({
    pool: options.pool,
    stripe: options.stripe(),
    clock: options.clock,
  });
  const user = (p: { kind: string; userId?: string }) => {
    if (p.kind !== "user" || !p.userId) throw new ApiError("forbidden", "this is a person's work");
    return p.userId;
  };

  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/song-queue",
    { config: route({ ...staff, principals: [...staff.principals], action: "pos.use" }) },
    async (request) => request.inVenue((c) => queueView(c, request.venueId!, options.clock.now())),
  );

  // The Up next TV: a paired `up_next_display` and nothing else (Tenancy and access · Up next display).
  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/up-next",
    { config: route({ principals: ["up_next_display"], module: "bar_mode" }) },
    async (request) =>
      request.inVenue((c) => upNextDisplay(c, request.venueId!, options.clock.now())),
  );

  const queueBody = z
    .object({
      singer_id: id,
      title: z.string().trim().min(1).max(120),
      artist: z.string().trim().max(120).nullable().optional(),
      catalog_id: id.nullable().optional(),
    })
    .strict();
  app.post<{ Params: { venueId: string }; Body: unknown }>(
    "/v1/venues/:venueId/song-queue",
    {
      config: route({
        ...staff,
        principals: [...staff.principals],
        action: "pos.use",
        idempotency: "optional",
      }),
    },
    async (request, reply) => {
      const parsed = queueBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError("invalid_request", "send { singer_id, title, artist? }");
      const userId = user(request.principal);
      const b = parsed.data;
      const song = await request.inVenue((c) =>
        queueSong(c, request.venueId!, {
          singerId: b.singer_id,
          title: b.title,
          artist: b.artist || null,
          catalogId: b.catalog_id ?? null,
          userId,
          now: options.clock.now(),
        }),
      );
      return reply.code(201).send(song);
    },
  );

  // Started: a money route (the song's line), so it takes an Idempotency-Key. A hold raise runs outside the
  // transaction, then the start is tried once more, as a round's send is.
  app.post<{ Params: { venueId: string; q: string } }>(
    "/v1/venues/:venueId/song-queue/:q/start",
    {
      config: route({
        ...staff,
        principals: [...staff.principals],
        action: "pos.use",
        idempotency: "required",
      }),
    },
    async (request) => {
      if (!uuid.test(request.params.q)) throw new ApiError("not_found", "no such song");
      const userId = user(request.principal);
      const venueId = request.venueId!;
      const input = { queueId: request.params.q, userId, source: "staff" as const };
      let answer: StartAnswer = await request.inVenue((c) =>
        startSong(c, venueId, { ...input, now: options.clock.now() }),
      );
      if (answer.kind === "raise") {
        await runNow(deps(), venueId, answer.paymentId, answer.attemptNo);
        answer = await request.inVenue((c) =>
          startSong(c, venueId, { ...input, now: options.clock.now(), raised: true }),
        );
      }
      if (answer.kind === "checking" || answer.kind === "raise")
        throw new ApiError("payment_unknown", "Checking with Stripe · don't retry", {
          details: { reason: "hold_checking", payment_id: answer.paymentId },
        });
      return answer.song;
    },
  );

  app.post<{ Params: { venueId: string; q: string } }>(
    "/v1/venues/:venueId/song-queue/:q/skip",
    {
      config: route({
        ...staff,
        principals: [...staff.principals],
        action: "pos.use",
        idempotency: "optional",
      }),
    },
    async (request) => {
      if (!uuid.test(request.params.q)) throw new ApiError("not_found", "no such song");
      const userId = user(request.principal);
      return request.inVenue((c) =>
        skipSong(c, request.venueId!, {
          queueId: request.params.q,
          userId,
          now: options.clock.now(),
        }),
      );
    },
  );

  const moveBody = z
    .object({ direction: z.enum(["up", "down"]), reason: z.string().trim().min(1).max(300) })
    .strict();
  app.post<{ Params: { venueId: string; q: string }; Body: unknown }>(
    "/v1/venues/:venueId/song-queue/:q/move",
    {
      config: route({
        ...staff,
        principals: [...staff.principals],
        action: "pos.use",
        idempotency: "optional",
      }),
    },
    async (request) => {
      if (!uuid.test(request.params.q)) throw new ApiError("not_found", "no such song");
      const parsed = moveBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError("invalid_request", "a move needs a direction and a reason", {
          details: { reason: "reason_required" },
        });
      const userId = user(request.principal);
      return request.inVenue((c) =>
        moveSong(c, request.venueId!, {
          queueId: request.params.q,
          direction: parsed.data.direction,
          reason: parsed.data.reason,
          userId,
          now: options.clock.now(),
        }),
      );
    },
  );

  app.get<{ Params: { venueId: string; q: string } }>(
    "/v1/venues/:venueId/song-queue/:q/moves",
    { config: route({ ...staff, principals: [...staff.principals], action: "pos.use" }) },
    async (request) => {
      if (!uuid.test(request.params.q)) throw new ApiError("not_found", "no such song");
      const moves = await request.inVenue((c) => songMoves(c, request.venueId!, request.params.q));
      return { moves };
    },
  );

  const singerBody = z
    .object({
      display_name: z.string().trim().min(1).max(40),
      phone_e164: z.string().regex(/^\+1[2-9]\d{2}[2-9]\d{6}$/),
      tab_id: id.nullable().optional(),
      locale: z.enum(["en", "es"]).optional(),
    })
    .strict();
  app.post<{ Params: { venueId: string }; Body: unknown }>(
    "/v1/venues/:venueId/singers",
    {
      config: route({
        ...staff,
        principals: [...staff.principals],
        action: "pos.use",
        idempotency: "optional",
      }),
    },
    async (request, reply) => {
      const parsed = singerBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError("invalid_request", "send { display_name, phone_e164 } with a +1 number");
      const userId = user(request.principal);
      const b = parsed.data;
      const singer = await request.inVenue((c) =>
        addSinger(c, request.venueId!, {
          displayName: b.display_name,
          phoneE164: b.phone_e164,
          tabId: b.tab_id ?? null,
          userId,
          locale: b.locale ?? "en",
          now: options.clock.now(),
        }),
      );
      return reply.code(singer.code_sent ? 201 : 200).send(singer);
    },
  );

  const verifyBody = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
  app.post<{ Params: { venueId: string; s: string }; Body: unknown }>(
    "/v1/venues/:venueId/singers/:s/verify",
    {
      config: route({
        ...staff,
        principals: [...staff.principals],
        action: "pos.use",
        idempotency: "optional",
      }),
    },
    async (request) => {
      if (!uuid.test(request.params.s)) throw new ApiError("not_found", "no such singer");
      const parsed = verifyBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { code }: six digits");
      user(request.principal);
      const r = await request.inVenue((c) =>
        verifySinger(c, request.venueId!, {
          singerId: request.params.s,
          code: parsed.data.code,
          now: options.clock.now(),
        }),
      );
      // A wrong code is counted, so the count commits before the refusal.
      if ("wrong" in r)
        throw new ApiError("invalid_request", "that code isn't right", {
          details: { reason: "wrong_code", tries_left: r.tries_left },
        });
      return r;
    },
  );

  const creditBody = z.union([
    z.object({ check_id: id }).strict(),
    z
      .object({
        prepaid: z
          .object({
            count: z.number().int().min(1).max(20),
            tendered_cents: z.number().int().min(0).max(10_000_00),
          })
          .strict(),
      })
      .strict(),
  ]);
  app.post<{ Params: { venueId: string; s: string }; Body: unknown }>(
    "/v1/venues/:venueId/singers/:s/credits",
    {
      config: route({
        ...staff,
        principals: [...staff.principals],
        action: "pos.use",
        idempotency: "required",
      }),
    },
    async (request, reply) => {
      if (!uuid.test(request.params.s)) throw new ApiError("not_found", "no such singer");
      const parsed = creditBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError(
          "invalid_request",
          "send { check_id } for a sale, or { prepaid: { count, tendered_cents } }",
        );
      const userId = user(request.principal);
      const body = parsed.data;
      const now = options.clock.now();
      if ("check_id" in body) {
        const r = await request.inVenue((c) =>
          giveSaleCredits(c, request.venueId!, {
            singerId: request.params.s,
            checkId: body.check_id,
            userId,
            now,
          }),
        );
        return reply.code(r.earned > 0 ? 201 : 200).send(r);
      }
      const deviceId = request.signedDevice?.deviceId ?? request.session?.deviceId ?? null;
      const r = await request.inVenue((c) =>
        buyPrepaidCredits(c, request.venueId!, {
          singerId: request.params.s,
          count: body.prepaid.count,
          tenderedCents: body.prepaid.tendered_cents,
          userId,
          deviceId,
          now,
        }),
      );
      return reply.code(201).send(r);
    },
  );
}
