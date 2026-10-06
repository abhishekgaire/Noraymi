import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import type { Clock } from "@west4/shared";
import {
  emitEvent,
  insertPrintJob,
  latePostsTo,
  nightClose,
  postingDate,
  recordNightClose,
  recordPunch,
  type Queryable,
} from "@west4/db";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { closePool, nightTips, poolOf } from "../tips/pool.js";
import { nightChecks } from "../nights/checks.js";
import { computeReport, nightReport, reportPrintLines } from "../nights/report.js";
import { postNightExport } from "../nights/journal.js";
import { venueClock } from "../rooms/assignment.js";
import type { PaymentDeps } from "../payments/run.js";
import type { StripeClient } from "../stripe/client.js";
import { listTabs } from "../tabs/tabs.js";
import { chargeTabs, cutOffDue, driveWalkout } from "../tabs/walkout.js";
import { failedTabs } from "../tabs/settle.js";
import { Temporal } from "@west4/shared";

/**
 * Close the night's bar tabs (M6-16; API · Night close; Staff screens · Charging the remaining tabs;
 * screens Night note 5). M7 builds the rest of the night's checks on the same GET.
 *   GET  /v1/venues/{v}/nights/{date}                          whether the night is closed (its Z number) and
 *                                                              where its late money posts (M7-02); the open bar
 *                                                              tabs with their totals and cards,
 *                                                              which of them Charge the remaining tabs takes
 *                                                              (how many cards and the total), and the cut-off
 *   POST /v1/venues/{v}/nights/{date}/charge-remaining-tabs    { count, total_cents }: the confirmation as the
 *                                                              manager saw it; every open tab not waiting on an
 *                                                              approval is charged at its balance with no tip
 */
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const chargeBody = z
  .object({ count: z.number().int().min(1), total_cents: z.number().int().min(1) })
  .strict();

type Listed = Awaited<ReturnType<typeof listTabs>>[number];

/** The night's open bar tabs, and what Charge the remaining tabs would take. */
async function barTabs(c: Queryable, venueId: string, now: Temporal.Instant) {
  const tabs = (await listTabs(c, venueId, now)).filter(
    (t) => t.state === "open" || t.state === "tipping",
  );
  const chargeable = (t: Listed) =>
    t.state === "open" && t.waiting_for === null && t.card !== null && t.rest_cents > 0;
  const remaining = tabs.filter(chargeable);
  return {
    tabs: tabs.map((t) => ({
      id: t.id,
      name: t.name,
      label: t.label,
      state: t.state,
      card: t.card,
      total_cents: t.totals?.total_cents ?? 0,
      rest_cents: t.rest_cents,
      waiting_for: t.waiting_for,
      chargeable: chargeable(t),
    })),
    remaining,
  };
}

async function nightOf(c: Queryable, venueId: string, date: string, now: Temporal.Instant) {
  // Tonight is the posting date (M7-02): once a night closes before the cutover, the next one has begun.
  const today = Temporal.PlainDate.from(await postingDate(c, venueId, now));
  const night = Temporal.PlainDate.from(date);
  if (Temporal.PlainDate.compare(night, today) > 0)
    throw new ApiError("not_found", "that night hasn't started");
  return night;
}

export function nightRoutes(
  app: FastifyInstance,
  options: { clock: Clock; pool: pg.Pool; stripe: () => StripeClient },
): void {
  const deps = (): PaymentDeps => ({
    pool: options.pool,
    stripe: options.stripe(),
    clock: options.clock,
  });

  // The night's report (M7-13): the running X report until the close, then the Z report as written then.
  app.get<{ Params: { venueId: string; date: string } }>(
    "/v1/venues/:venueId/nights/:date/report",
    { config: route({ principals: ["owner_manager"], module: "core", action: "night.close" }) },
    async (request) => {
      if (!DATE.test(request.params.date)) throw new ApiError("not_found", "no such night");
      const venueId = request.venueId!;
      const now = options.clock.now();
      return request.inVenue(async (c) => {
        await nightOf(c, venueId, request.params.date, now);
        return nightReport(c, venueId, request.params.date, now);
      });
    },
  );

  // Print the X report (running) or the Z report (only after the close) on the front-desk receipt printer.
  const printBody = z.object({ kind: z.enum(["x", "z"]) }).strict();
  app.post<{ Params: { venueId: string; date: string }; Body: unknown }>(
    "/v1/venues/:venueId/nights/:date/report/print",
    {
      config: route({
        principals: ["owner_manager"],
        module: "core",
        action: "night.close",
        idempotency: "optional",
      }),
    },
    async (request) => {
      if (!DATE.test(request.params.date)) throw new ApiError("not_found", "no such night");
      const parsed = printBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { kind: 'x' | 'z' }");
      const venueId = request.venueId!;
      const now = options.clock.now();
      return request.inVenue(async (c) => {
        await nightOf(c, venueId, request.params.date, now);
        const report = await nightReport(c, venueId, request.params.date, now);
        if (parsed.data.kind === "z" && report.kind !== "z")
          throw new ApiError("invalid_request", "the Z report prints only after the night closes", {
            details: { reason: "not_closed" },
          });
        if (parsed.data.kind === "x" && report.kind === "z")
          throw new ApiError("invalid_request", "this night is closed: print its Z report", {
            details: { reason: "closed" },
          });
        // The front-desk receipt printer: the one the front-desk drawer kicks through.
        const printer = (
          await c.query<{ id: string }>(
            "select printer_device_id as id from cash_drawers where venue_id = $1 and station = 'front_desk' and printer_device_id is not null",
            [venueId],
          )
        ).rows[0];
        if (!printer) throw new ApiError("invalid_request", "there's no front-desk printer paired");
        const money = (cents: number) =>
          `${cents < 0 ? "−" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        const job = await insertPrintJob(c, venueId, {
          kind: parsed.data.kind === "z" ? "z_report" : "x_report",
          station: "front_desk",
          deviceId: printer.id,
          payload: { lines: reportPrintLines(report, money) },
          createdAt: now.toString(),
        });
        return { print_job_id: job, kind: parsed.data.kind };
      });
    },
  );

  // The night's tips (M7-09): gratuity, card tips and cash tips, each person's share, who's left out.
  app.get<{ Params: { venueId: string; date: string } }>(
    "/v1/venues/:venueId/nights/:date/tips",
    {
      config: route({
        principals: ["owner_manager"],
        module: "core",
        action: "night.close",
      }),
    },
    async (request) => {
      if (!DATE.test(request.params.date)) throw new ApiError("not_found", "no such night");
      const venueId = request.venueId!;
      return request.inVenue((c) =>
        nightTips(c, venueId, request.params.date, options.clock.now()),
      );
    },
  );

  app.get<{ Params: { venueId: string; date: string } }>(
    "/v1/venues/:venueId/nights/:date",
    {
      config: route({
        principals: ["owner_manager", "staff"],
        module: "core",
        action: "night.close",
      }),
    },
    async (request) => {
      if (!DATE.test(request.params.date)) throw new ApiError("not_found", "no such night");
      const venueId = request.venueId!;
      const now = options.clock.now();
      return request.inVenue(async (c) => {
        const night = await nightOf(c, venueId, request.params.date, now);
        const { tabs, remaining } = await barTabs(c, venueId, now);
        const cutOff = await cutOffDue(c, venueId, night);
        const closed = await nightClose(c, venueId, night.toString());
        return {
          business_date: night.toString(),
          // Closed nights never reopen (M7-02): the close, and where late money for this night posts
          // ("3 slips not entered · tips post to Sat Sep 26").
          closed: closed
            ? {
                z_number: closed.z_number,
                closed_at: closed.closed_at,
                closed_by: closed.closed_by,
              }
            : null,
          late_money_posts_to: await latePostsTo(c, venueId, night.toString(), now),
          bar_tabs: tabs,
          charge_remaining: {
            count: remaining.length,
            total_cents: remaining.reduce((s, t) => s + t.rest_cents, 0),
          },
          tab_cut_off_at: cutOff?.toString() ?? null,
          // Tabs whose capture failed, from any night, until a manager settles them (M6-17).
          capture_failed: await failedTabs(c, venueId),
          // The checks before closing (M7-12), each with its fix; the person asking is exempt from the clock.
          checks: await nightChecks(
            c,
            venueId,
            night.toString(),
            now,
            request.principal.kind === "user" ? request.principal.userId : null,
          ),
        };
      });
    },
  );

  /**
   * Close the night (M7-12): an owner or manager, after one confirmation and their PIN again in a
   * PIN or badge session. Every check runs again in one transaction; then the next Z number and
   * `night_closes` with the Z totals, the tip pool closed, unsent drafts and 86s cleared, the closing
   * manager clocked out, and `night.closed`. Two managers closing at once: one wins.
   */
  const closeBody = z
    .object({
      pin: z
        .string()
        .regex(/^\d{4,6}$/)
        .optional(),
    })
    .strict();
  app.post<{ Params: { venueId: string; date: string }; Body: unknown }>(
    "/v1/venues/:venueId/nights/:date/close",
    {
      config: route({
        principals: ["owner_manager", "staff"],
        module: "core",
        action: "night.close",
        idempotency: "optional",
      }),
    },
    async (request) => {
      if (!DATE.test(request.params.date)) throw new ApiError("not_found", "no such night");
      const parsed = closeBody.safeParse(request.body ?? {});
      if (!parsed.success) throw new ApiError("invalid_request", "send { pin? }");
      const p = request.principal;
      if (p.kind !== "user") throw new ApiError("forbidden", "a person closes the night");
      const m = p.memberships.find((x) => x.venueId === request.venueId);
      if (m?.role !== "owner" && m?.role !== "manager")
        throw new ApiError("forbidden", "an owner or a manager closes the night");
      if (p.session === "pin" || p.session === "badge") {
        if (!parsed.data.pin)
          throw new ApiError("invalid_request", "closing the night asks for your PIN again", {
            details: { reason: "pin" },
          });
        await request.server.checkPinAgain(request, parsed.data.pin);
      }
      const venueId = request.venueId!;
      const now = options.clock.now();
      return request.inVenue(async (c) => {
        const date = (await nightOf(c, venueId, request.params.date, now)).toString();
        if (date !== (await postingDate(c, venueId, now)))
          throw new ApiError("invalid_request", "only tonight's business date closes");
        await c.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `night-close:${venueId}:${date}`,
        ]);
        if (await nightClose(c, venueId, date))
          throw new ApiError("version_conflict", "this night is already closed");
        const failing = (await nightChecks(c, venueId, date, now, p.userId)).filter(
          (x) => x.blocking,
        );
        if (failing.length > 0)
          throw new ApiError("night_open", "the night can't close yet", {
            details: { checks: failing.map((x) => ({ id: x.id, count: x.count, names: x.names })) },
          });
        // The closing manager clocks out at the close.
        const own = await c.query<{ id: string }>(
          "select id from memberships where venue_id = $1 and user_id = $2",
          [venueId, p.userId],
        );
        const open = await c.query(
          "select 1 from shifts where venue_id = $1 and membership_id = $2 and ended_at is null",
          [venueId, own.rows[0]!.id],
        );
        if ((open.rowCount ?? 0) > 0)
          await recordPunch(c, {
            venueId,
            membershipId: own.rows[0]!.id,
            kind: "clock_out",
            at: now,
            venue: await venueClock(c, venueId),
          });
        // The tip pool closes with the night: its shares are written once (M7-09).
        await poolOf(c, venueId, date);
        await closePool(c, venueId, date, now);
        // Rooms and bar tabs counted apart.
        const counts = (
          await c.query<{ rooms: number; bar_tabs: number }>(
            `select count(*) filter (where kind = 'room')::int as rooms, count(*) filter (where kind = 'bar')::int as bar_tabs
               from checks where venue_id = $1 and business_date = $2::date and not training and status <> 'void'`,
            [venueId, date],
          )
        ).rows[0]!;
        // The Z report (M7-13), worked out once now and stored with the close: never recomputed.
        const closer =
          (await c.query<{ name: string }>("select name from users where id = $1", [p.userId]))
            .rows[0]?.name ?? null;
        const z = await computeReport(c, venueId, date, now, "z");
        // The night's accounting journal, posted from the same lines (M7-15), and its file.
        const exportId = await postNightExport(c, venueId, { date, report: z, userId: p.userId });
        const closed = await recordNightClose(c, venueId, {
          businessDate: date,
          closedAt: now.toString(),
          closedBy: p.userId,
          exportId,
          totals: {
            checks: counts,
            report: { ...z, closed: { z_number: 0, closed_at: now.toString(), closed_by: closer } },
          },
        });
        // Unsent drinks left are cleared, and tonight's 86s end.
        await c.query(
          "update order_drafts set lines = '[]', version = version + 1, updated_at = $2 where venue_id = $1 and jsonb_array_length(lines) > 0",
          [venueId, now.toString()],
        );
        for (const table of ["menu_items", "menu_variants", "menu_options"])
          await c.query(
            `update ${table} set out_until = null where venue_id = $1 and out_until > $2`,
            [venueId, now.toString()],
          );
        await emitEvent(c, { venueId, type: "menu.changed", entityId: venueId });
        await emitEvent(c, { venueId, type: "night.closed", entityId: venueId });
        return {
          business_date: date,
          z_number: closed.z_number,
          closed_at: closed.closed_at,
          closed_by: closed.closed_by,
          checks: counts,
        };
      });
    },
  );

  app.post<{ Params: { venueId: string; date: string }; Body: unknown }>(
    "/v1/venues/:venueId/nights/:date/charge-remaining-tabs",
    {
      config: route({
        principals: ["owner_manager", "staff"],
        module: "bar_tabs",
        action: "night.close",
        idempotency: "required",
      }),
    },
    async (request) => {
      if (!DATE.test(request.params.date)) throw new ApiError("not_found", "no such night");
      const parsed = chargeBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { count, total_cents }");
      const p = request.principal;
      if (p.kind !== "user") throw new ApiError("forbidden", "this is a person's work");
      const venueId = request.venueId!;
      const now = options.clock.now();
      const remaining = await request.inVenue(async (c) => {
        await nightOf(c, venueId, request.params.date, now);
        return (await barTabs(c, venueId, now)).remaining;
      });
      const total = remaining.reduce((s, t) => s + t.rest_cents, 0);
      // One confirmation: what the manager confirmed is what gets charged, or nothing is.
      if (remaining.length !== parsed.data.count || total !== parsed.data.total_cents)
        throw new ApiError("version_conflict", "the open tabs changed: confirm again", {
          details: { reason: "tabs_changed", count: remaining.length, total_cents: total },
        });
      const payments = deps();
      const results = await chargeTabs(payments, venueId, remaining, {
        by: "charge_remaining",
        userId: p.userId,
      });
      // The captures run here and now; the worker runs the same jobs if this process can't.
      for (const r of results) if (r.closingId) await driveWalkout(payments, venueId, r.closingId);
      const after = await request.inVenue((c) => listTabs(c, venueId, options.clock.now()));
      return {
        tabs: results.map((r) => {
          const tab = after.find((t) => t.id === r.id);
          return {
            id: r.id,
            name: tab?.name ?? null,
            state: tab?.state ?? null,
            started: r.started,
            reason: r.reason,
          };
        }),
      };
    },
  );
}
