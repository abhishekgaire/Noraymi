import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  claimPrintJob,
  emitEvent,
  failStalePrintJobs,
  failedTickets,
  insertPrintJob,
  printerJob,
  reprintJob,
  resolvePrinter,
  settlePrintJob,
  withVenue,
  type PrintJobRow,
  type Queryable,
  type Sweep,
} from "@west4/db";
import type { Clock, Temporal } from "@west4/shared";
import { z } from "zod";
import type { Authenticator } from "../http/conventions.js";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import {
  DRAWER_MARKUP,
  DRAWER_MARKUP_TYPE,
  drawerKickEpos,
  drawerKickEscPos,
  ticketEpos,
  ticketEscPos,
  ticketText,
  type TicketPayload,
} from "../print/ticket.js";

/**
 * Printing tickets to network printers (M3-13; spec 09 · Tickets; spec 02 · Printer):
 *   POST   /v1/print/cloudprnt              a Star CloudPRNT poll: { jobReady, mediaTypes, jobToken }
 *   GET    /v1/print/cloudprnt?token=       the job's ticket, as text/plain
 *   DELETE /v1/print/cloudprnt?token=&code= the printer's confirmation ("200 OK"), or its error
 *   POST   /v1/print/epson                  Epson Server Direct Print: GetRequest answers ePOS-Print XML; SetResponse confirms
 *   GET    /v1/venues/{v}/print-jobs?status=failed     tickets that didn't print and haven't been reprinted
 *   POST   /v1/venues/{v}/print-jobs/{j}/reprint       a new job, "REPRINT 2", then 3 and so on
 *   POST   /v1/venues/{v}/printers                     Admin: add a printer, its credential shown once
 *   POST   /v1/venues/{v}/printers/{d}/test            Admin: print a test ticket on it
 *   POST   /v1/venues/{v}/print-host/next              a desktop host's USB printer: its next job as ESC/POS (M3-14)
 *   POST   /v1/venues/{v}/print-host/jobs/{j}          the host's word on it: { printer_id, printed, failure? }
 * A printer signs in with HTTP Basic (its device id and secret) and sees only its own jobs. A job not
 * confirmed within three 5-second polls is marked failed by the print watch, and print_job.failed tells
 * the bar orders screen and the board.
 */
export const PRINT_POLL_MS = 5_000;
export const PRINT_FAIL_AFTER_MS = 3 * PRINT_POLL_MS;
const secretHash = (secret: string) => createHash("sha256").update(secret).digest("hex");

declare module "fastify" {
  interface FastifyRequest {
    /** The printer behind a print poll (M3-13), set by the printer authenticator. */
    printer?: { deviceId: string; venueId: string; station: string; protocol: string };
  }
}

/** On /v1/print/ only: HTTP Basic with the printer's device id and secret. */
export function printerAuthenticator(pool: pg.Pool): Authenticator {
  return async (request) => {
    if (!request.url.startsWith("/v1/print/")) return undefined;
    const auth = request.headers.authorization;
    if (typeof auth !== "string" || !auth.startsWith("Basic ")) return undefined;
    const [user, ...rest] = Buffer.from(auth.slice(6), "base64").toString("utf8").split(":");
    const secret = rest.join(":");
    if (!user || !secret || !z.string().uuid().safeParse(user).success) return undefined;
    const found = await resolvePrinter(pool, user, secretHash(secret));
    if (!found) return undefined;
    request.printer = { deviceId: user, ...found };
    return { kind: "device", deviceId: user, venueId: found.venueId, deviceKind: "printer" };
  };
}

async function venueZone(c: Queryable, venueId: string): Promise<string> {
  const r = await c.query<{ time_zone: string }>("select time_zone from venues where id = $1", [
    venueId,
  ]);
  return r.rows[0]?.time_zone ?? "America/New_York";
}

async function announce(c: Queryable, venueId: string, job: PrintJobRow, type: string) {
  await emitEvent(c, { venueId, type, entityId: job.id, entityVersion: 0 });
}

/** The print watch: every 5 seconds, a job still unconfirmed after three polls is failed and the bar is told. */
export function printWatchSweep(pool: pg.Pool): Sweep {
  return {
    name: "print.watch",
    everyMs: PRINT_POLL_MS,
    run: async (now) => void (await sweepPrintJobs(pool, now)),
  };
}

export async function sweepPrintJobs(pool: pg.Pool, now: Temporal.Instant): Promise<number> {
  const venues = await pool.query<{ id: string }>("select id from venues_for_scheduler()");
  let failed = 0;
  for (const v of venues.rows) {
    failed += await withVenue(pool, { venueId: v.id, requestId: "sweep:print" }, async (c) => {
      const gone = await failStalePrintJobs(
        c,
        v.id,
        now.subtract({ milliseconds: PRINT_FAIL_AFTER_MS }).toString(),
        now.toString(),
      );
      for (const job of gone) await announce(c, v.id, job, "print_job.failed");
      return gone.length;
    });
  }
  return failed;
}

export function printRoutes(app: FastifyInstance, options: { pool: pg.Pool; clock: Clock }): void {
  const printer = route({
    principals: ["printer"],
    module: "core",
    idempotency: "none",
    rateLimit: false,
  });
  const me = (request: FastifyRequest) => {
    if (!request.printer)
      throw new ApiError("unauthorized", "a printer signs in with its id and secret");
    return request.printer;
  };
  const inPrinterVenue = <T>(request: FastifyRequest, work: (c: Queryable) => Promise<T>) =>
    withVenue(options.pool, { venueId: me(request).venueId, requestId: request.requestId }, work);

  // Epson posts form fields, parsed by the scope's form parser (twilio-hooks.ts); CloudPRNT posts JSON.

  /** Hands the printer its next job, if any, marking it sent. */
  const nextJob = (request: FastifyRequest) =>
    inPrinterVenue(request, (c) =>
      claimPrintJob(c, me(request).venueId, {
        deviceId: me(request).deviceId,
        station: me(request).station,
        now: options.clock.now().toString(),
      }),
    );
  /** Records the printer's word on a job, and tells the bar if it failed. */
  const settle = (
    request: FastifyRequest,
    jobId: string,
    printed: boolean,
    failure: string | null,
  ) =>
    inPrinterVenue(request, async (c) => {
      const job = await settlePrintJob(c, me(request).venueId, me(request).deviceId, jobId, {
        printed,
        failure,
        now: options.clock.now().toString(),
      });
      if (job)
        await announce(
          c,
          me(request).venueId,
          job,
          printed ? "print_job.printed" : "print_job.failed",
        );
      return job;
    });

  app.post("/v1/print/cloudprnt", { config: printer }, async (request) => {
    const job = await nextJob(request);
    return job
      ? {
          jobReady: true,
          // A drawer kick is Star markup; a ticket is plain text (M4-13).
          mediaTypes: [job.kind === "drawer" ? DRAWER_MARKUP_TYPE : "text/plain"],
          jobToken: job.id,
        }
      : { jobReady: false };
  });

  app.get<{ Querystring: { token?: string } }>(
    "/v1/print/cloudprnt",
    { config: printer },
    async (request, reply) => {
      const token = request.query.token ?? "";
      if (!z.string().uuid().safeParse(token).success)
        throw new ApiError("not_found", "no such job");
      const text = await inPrinterVenue(request, async (c) => {
        const job = await printerJob(c, me(request).venueId, me(request).deviceId, token);
        if (!job) throw new ApiError("not_found", "no such job");
        if (job.kind === "drawer") return { kick: true, body: DRAWER_MARKUP };
        return {
          kick: false,
          body: ticketText(job.payload as TicketPayload, {
            timeZone: await venueZone(c, me(request).venueId),
            reprintN: job.reprint_n,
          }),
        };
      });
      return reply
        .type(text.kick ? `${DRAWER_MARKUP_TYPE}; charset=utf-8` : "text/plain; charset=utf-8")
        .send(text.body);
    },
  );

  app.delete<{ Querystring: { token?: string; code?: string } }>(
    "/v1/print/cloudprnt",
    { config: printer },
    async (request) => {
      const token = request.query.token ?? "";
      if (!z.string().uuid().safeParse(token).success)
        throw new ApiError("not_found", "no such job");
      // CloudPRNT reports "200 OK" for a printed job, and another code (such as "520 PAPER EMPTY") otherwise.
      const code = (request.query.code ?? "").trim();
      const printed = /^(2\d\d|OK)\b/i.test(code);
      const job = await settle(
        request,
        token,
        printed,
        printed ? null : code || "unknown printer error",
      );
      if (!job) throw new ApiError("not_found", "no such job");
      return { ok: true };
    },
  );

  app.post<{ Body: Record<string, string> }>(
    "/v1/print/epson",
    { config: printer },
    async (request, reply) => {
      const body = request.body ?? {};
      if (body["ConnectionType"] === "SetResponse") {
        const file = body["ResponseFile"] ?? "";
        for (const m of file.matchAll(/<response\b([^>]*)\/?>/g)) {
          const attrs = m[1] ?? "";
          const jobId = /printjobid="([^"]+)"/.exec(attrs)?.[1] ?? "";
          const success = /success="true"/.test(attrs);
          const code = /code="([^"]*)"/.exec(attrs)?.[1] ?? "";
          if (z.string().uuid().safeParse(jobId).success)
            await settle(request, jobId, success, success ? null : code || "unknown printer error");
        }
        return reply.type("text/plain").send("");
      }
      const job = await nextJob(request);
      if (!job) return reply.type("text/xml; charset=utf-8").send("");
      const xmlBody = await inPrinterVenue(request, async (c) =>
        job.kind === "drawer"
          ? drawerKickEpos(job.id)
          : ticketEpos(job.payload as TicketPayload, {
              timeZone: await venueZone(c, me(request).venueId),
              reprintN: job.reprint_n,
              jobId: job.id,
            }),
      );
      return reply.type("text/xml; charset=utf-8").send(xmlBody);
    },
  );

  // The bar's side.
  app.get<{ Params: { venueId: string }; Querystring: { status?: string } }>(
    "/v1/venues/:venueId/print-jobs",
    { config: route({ principals: ["owner_manager", "staff", "shared_device"], module: "core" }) },
    async (request) => {
      if ((request.query.status ?? "failed") !== "failed")
        throw new ApiError("invalid_request", "status=failed is the only list");
      return {
        jobs: await request.inVenue((c) =>
          failedTickets(c, request.venueId!, options.clock.now().toString()),
        ),
      };
    },
  );

  app.post<{ Params: { venueId: string; jobId: string } }>(
    "/v1/venues/:venueId/print-jobs/:jobId/reprint",
    {
      config: route({
        principals: ["owner_manager", "staff"],
        module: "core",
        action: "orders.accept",
        idempotency: "optional",
      }),
    },
    async (request, reply) => {
      if (!z.string().uuid().safeParse(request.params.jobId).success)
        throw new ApiError("not_found", "no such print job");
      const made = await request.inVenue(async (c) => {
        const r = await reprintJob(
          c,
          request.venueId!,
          request.params.jobId,
          options.clock.now().toString(),
        );
        if (!r) throw new ApiError("not_found", "no such print job");
        await emitEvent(c, {
          venueId: request.venueId!,
          type: "print_job.queued",
          entityId: r.id,
          entityVersion: 0,
        });
        return r;
      });
      return reply.code(201).send({ job_id: made.id, reprint_n: made.reprint_n });
    },
  );

  // Admin → Printers & devices.
  const admin = route({
    principals: ["owner_manager"],
    module: "core",
    action: "admin.access",
    idempotency: "optional",
  });
  const printerBody = z
    .object({
      name: z.string().trim().min(1).max(60),
      station: z.string().trim().min(1).max(40),
      protocol: z.enum(["cloudprnt", "server_direct"]),
    })
    .strict();
  app.post<{ Params: { venueId: string }; Body: unknown }>(
    "/v1/venues/:venueId/printers",
    { config: admin },
    async (request, reply) => {
      const parsed = printerBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError("invalid_request", "send { name, station, protocol }");
      const secret = randomBytes(18).toString("base64url");
      const id = await request.inVenue(async (c) => {
        const r = await c.query<{ id: string }>(
          `insert into devices (venue_id, kind, name, station, protocol, secret_hash)
           values ($1, 'printer', $2, $3, $4, $5) returning id`,
          [
            request.venueId,
            parsed.data.name,
            parsed.data.station,
            parsed.data.protocol,
            secretHash(secret),
          ],
        );
        await emitEvent(c, {
          venueId: request.venueId!,
          type: "device.updated",
          entityId: r.rows[0]!.id,
          entityVersion: 0,
        });
        return r.rows[0]!.id;
      });
      // The credential is shown once; only its hash is kept.
      return reply.code(201).send({
        device_id: id,
        username: id,
        password: secret,
        poll_path: parsed.data.protocol === "cloudprnt" ? "/v1/print/cloudprnt" : "/v1/print/epson",
        station: parsed.data.station,
      });
    },
  );

  app.post<{ Params: { venueId: string; d: string } }>(
    "/v1/venues/:venueId/printers/:d/test",
    { config: admin },
    async (request, reply) => {
      if (!z.string().uuid().safeParse(request.params.d).success)
        throw new ApiError("not_found", "no such printer");
      const job = await request.inVenue(async (c) => {
        const p = await c.query<{ name: string; station: string | null }>(
          "select name, station from devices where venue_id = $1 and id = $2 and kind = 'printer' and revoked_at is null",
          [request.venueId, request.params.d],
        );
        if (!p.rows[0]) throw new ApiError("not_found", "no such printer");
        return insertPrintJob(c, request.venueId!, {
          kind: "ticket",
          checkId: null,
          orderId: null,
          station: p.rows[0].station ?? "bar",
          deviceId: request.params.d,
          payload: { test: { printer: p.rows[0].name } },
          createdAt: options.clock.now().toString(),
        });
      });
      return reply.code(201).send({ job_id: job });
    },
  );

  // A desktop app hosting USB printers (M3-14): it asks for each printer's next job over its signed
  // channel, prints the ESC/POS bytes, and confirms. A printer it doesn't host is no printer of its own.
  const host = route({
    principals: ["shared_device"],
    module: "core",
    idempotency: "none",
    rateLimit: false,
  });
  const hostedPrinter = async (c: Queryable, request: FastifyRequest, printerId: string) => {
    const h = request.signedDevice;
    if (!h || h.venueId !== request.venueId)
      throw new ApiError("forbidden", "a host prints on its own printers");
    const p = await c.query<{ station: string | null }>(
      `select station from devices where venue_id = $1 and id = $2 and kind = 'printer'
          and host_device_id = $3 and revoked_at is null`,
      [request.venueId, printerId, h.deviceId],
    );
    if (!p.rows[0]) throw new ApiError("not_found", "no such printer on this host");
    return p.rows[0].station ?? (h.kind === "front_desk" ? "front_desk" : "bar");
  };
  const nextBody = z.object({ printer_id: z.string().uuid() }).strict();
  app.post<{ Params: { venueId: string }; Body: unknown }>(
    "/v1/venues/:venueId/print-host/next",
    { config: host },
    async (request) => {
      const parsed = nextBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { printer_id }");
      return request.inVenue(async (c) => {
        const station = await hostedPrinter(c, request, parsed.data.printer_id);
        const job = await claimPrintJob(c, request.venueId!, {
          deviceId: parsed.data.printer_id,
          station,
          now: options.clock.now().toString(),
        });
        if (!job) return { job: null };
        const bytes =
          job.kind === "drawer"
            ? drawerKickEscPos()
            : ticketEscPos(job.payload as TicketPayload, {
                timeZone: await venueZone(c, request.venueId!),
                reprintN: job.reprint_n,
              });
        return {
          job: {
            id: job.id,
            reprint_n: job.reprint_n,
            escpos: Buffer.from(bytes).toString("base64"),
          },
        };
      });
    },
  );
  const doneBody = z
    .object({
      printer_id: z.string().uuid(),
      printed: z.boolean(),
      failure: z.string().max(200).nullable().optional(),
    })
    .strict();
  app.post<{ Params: { venueId: string; jobId: string }; Body: unknown }>(
    "/v1/venues/:venueId/print-host/jobs/:jobId",
    { config: host },
    async (request) => {
      const parsed = doneBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError("invalid_request", "send { printer_id, printed, failure? }");
      if (!z.string().uuid().safeParse(request.params.jobId).success)
        throw new ApiError("not_found", "no such job");
      return request.inVenue(async (c) => {
        await hostedPrinter(c, request, parsed.data.printer_id);
        const job = await settlePrintJob(
          c,
          request.venueId!,
          parsed.data.printer_id,
          request.params.jobId,
          {
            printed: parsed.data.printed,
            failure: parsed.data.failure ?? null,
            now: options.clock.now().toString(),
          },
        );
        if (!job) throw new ApiError("not_found", "no such job");
        await announce(
          c,
          request.venueId!,
          job,
          parsed.data.printed ? "print_job.printed" : "print_job.failed",
        );
        return { status: job.status };
      });
    },
  );
}
