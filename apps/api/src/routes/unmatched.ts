import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { allocate, amountDue, emitEvent, withOrgScope } from "@west4/db";
import type { Clock } from "@west4/shared";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { settleCheck } from "../rooms/present.js";

/**
 * Unmatched payments and payouts (M7-14; spec 06 · 8 and 11; screens N37 and
 * Night note 8):
 *   GET  /v1/venues/{v}/payments/unmatched       Stripe activity with no check: amount, card, time
 *   POST /v1/venues/{v}/payments/{p}/match        { check_id }: the check it belongs to
 *   GET  /v1/venues/{v}/reports/payouts           owner only: each payout and its lines; ?scope=org
 *                                                 reads every venue of the owner's organization
 * Matching writes the allocation, never over the check's amount due
 * (`422 over_amount_due`); a match to a closed night's check keeps the
 * payment where money posts now and points it back at the check's night.
 */
const match = z.object({ check_id: z.string().uuid() }).strict();

export function unmatchedRoutes(
  app: FastifyInstance,
  options: { clock: Clock; pool: pg.Pool },
): void {
  const managers = route({
    principals: ["owner_manager"],
    module: "core",
    action: "approvals.decide",
  });

  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/payments/unmatched",
    { config: managers },
    async (request) =>
      request.inVenue(async (c) => ({
        // The checks still owing, for the picker: this business date and the one before.
        checks: (
          await c.query<{
            id: string;
            label: string;
            business_date: string;
            amount_due_cents: number;
          }>(
            `select k.id, coalesce((select r.name from room_sessions rs join rooms r on r.venue_id = rs.venue_id and r.id = rs.room_id
                                     where rs.venue_id = k.venue_id and rs.id = k.room_session_id),
                                   (select t.name from tabs t where t.venue_id = k.venue_id and t.check_id = k.id), '#' || k.number) as label,
                    k.business_date::text, amount_due_read(k.id)::int as amount_due_cents
               from live_checks k
              where k.venue_id = $1 and k.status in ('finalized', 'partly_paid', 'open', 'reopened')
                and k.business_date >= (select max(business_date) from live_checks where venue_id = $1) - 1
              order by k.number`,
            [request.venueId],
          )
        ).rows.filter((k) => k.amount_due_cents > 0),
        payments: (
          await c.query<{
            id: string;
            amount_cents: number;
            card_brand: string | null;
            card_last4: string | null;
            at: string;
            business_date: string;
          }>(
            `select p.id, p.amount_cents::int as amount_cents, p.card_brand, p.card_last4,
                    to_json(p.created_at) #>> '{}' as at, p.business_date::text
               from live_payments p
              where p.venue_id = $1 and p.method = 'external' and p.status = 'captured' and p.booking_id is null
                and not exists (select 1 from payment_allocations a where a.venue_id = p.venue_id and a.payment_id = p.id)
              order by p.created_at`,
            [request.venueId],
          )
        ).rows,
      })),
  );

  app.post<{ Params: { venueId: string; p: string }; Body: unknown }>(
    "/v1/venues/:venueId/payments/:p/match",
    {
      config: route({
        principals: ["owner_manager"],
        module: "core",
        action: "approvals.decide",
        idempotency: "optional",
      }),
    },
    async (request) => {
      if (!z.string().uuid().safeParse(request.params.p).success)
        throw new ApiError("not_found", "no such payment");
      const parsed = match.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { check_id }");
      const venueId = request.venueId!;
      const now = options.clock.now();
      return request.inVenue(async (c) => {
        const payment = (
          await c.query<{ amount_cents: number; business_date: string }>(
            `select amount_cents::int as amount_cents, business_date::text from live_payments
              where venue_id = $1 and id = $2 and method = 'external' and status = 'captured' and booking_id is null for update`,
            [venueId, request.params.p],
          )
        ).rows[0];
        if (!payment) throw new ApiError("not_found", "no such unmatched payment");
        const taken = await c.query(
          "select 1 from payment_allocations where venue_id = $1 and payment_id = $2",
          [venueId, request.params.p],
        );
        if ((taken.rowCount ?? 0) > 0)
          throw new ApiError("version_conflict", "it's already matched");
        const check = (
          await c.query<{ business_date: string }>(
            "select business_date::text from live_checks where venue_id = $1 and id = $2",
            [venueId, parsed.data.check_id],
          )
        ).rows[0];
        if (!check) throw new ApiError("not_found", "no such check");
        const due = await amountDue(c, parsed.data.check_id);
        if (payment.amount_cents > due)
          throw new ApiError("over_amount_due", "that's more than the check still owes", {
            details: { amount_due_cents: due },
          });
        await allocate(c, venueId, {
          paymentId: request.params.p,
          checkId: parsed.data.check_id,
          amountCents: payment.amount_cents,
          state: "captured",
        });
        // Money for a night that's closed posts where money posts now and points back at that night.
        if (check.business_date < payment.business_date)
          await c.query(
            "update payments set adjusts_business_date = $3 where venue_id = $1 and id = $2 and adjusts_business_date is null",
            [venueId, request.params.p, check.business_date],
          );
        const settled = await settleCheck(c, venueId, parsed.data.check_id, now);
        await emitEvent(c, { venueId, type: "payment.updated", entityId: request.params.p });
        await emitEvent(c, { venueId, type: "check.updated", entityId: parsed.data.check_id });
        return {
          payment_id: request.params.p,
          check_id: parsed.data.check_id,
          amount_due_cents: await amountDue(c, parsed.data.check_id),
          settled,
        };
      });
    },
  );

  app.get<{ Params: { venueId: string }; Querystring: { scope?: string } }>(
    "/v1/venues/:venueId/reports/payouts",
    { config: route({ principals: ["owner_manager"], module: "reports", action: "admin.access" }) },
    async (request) => {
      const p = request.principal;
      const m =
        p.kind === "user" ? p.memberships.find((x) => x.venueId === request.venueId) : undefined;
      if (p.kind !== "user" || m?.role !== "owner")
        throw new ApiError("forbidden", "payouts are the owner's report");
      const read = async (c: Parameters<Parameters<typeof withOrgScope>[2]>[0]) => {
        const payouts = await c.query<{
          venue_id: string;
          stripe_payout_id: string;
          amount_cents: number;
          arrival_date: string | null;
          reconciled: boolean;
          lines: number;
          net_cents: number;
        }>(
          `select o.venue_id, o.stripe_payout_id, o.amount_cents::int as amount_cents, o.arrival_date::text, o.reconciled,
                  (select count(*)::int from payout_lines l where l.venue_id = o.venue_id and l.payout_id = o.id) as lines,
                  (select coalesce(sum(l.net_cents), 0)::int from payout_lines l where l.venue_id = o.venue_id and l.payout_id = o.id) as net_cents
             from payouts o order by o.created_at desc, o.venue_id`,
        );
        return payouts.rows;
      };
      if (request.query.scope === "org")
        return {
          scope: "org",
          payouts: await withOrgScope(options.pool, { userId: p.userId }, read),
        };
      return { scope: "venue", payouts: await request.inVenue(read) };
    },
  );
}
