import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import type { Clock } from "@west4/shared";
import { latePostsTo, nightClose, postingDate, type Queryable } from "@west4/db";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { nightTips } from "../tips/pool.js";
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
