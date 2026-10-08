import type pg from "pg";
import {
  decryptSecret,
  emitEvent,
  enqueue,
  ingestStripeEvent,
  markMessage,
  recordWebhookEvent,
  stripeAccountFor,
  twilioIntegration,
  withVenue,
  type JobRow,
  type Queryable,
} from "@west4/db";
import type { Clock } from "@west4/shared";
import { reconcileVenue, recordUnmatched } from "../payments/reconcile.js";
import type { StripeClient } from "../stripe/client.js";
import type { StripeIntent } from "../stripe/payments.js";
import {
  ENDPOINT_EVENTS,
  STRIPE_EVENT_KIND,
  makeStripeEventHandler,
  type WebhookEndpoint,
} from "../stripe/webhooks.js";
import { receiveText } from "../texts/inbox.js";
import type { VenueTextClient, VenueTextSettings } from "../texts/venue.js";

/**
 * The pull after a restore (M8-20; spec 13 · Backups and restore): what
 * Stripe and Twilio did since the restore point, through the usual paths, so
 * the restored venue catches up with the world.
 *
 *   - Stripe's events since then (payments, refunds, disputes, payouts) are
 *     stored like webhooks and run through their handlers (`stripe.event`);
 *   - open payment attempts the copy brought back are settled by the
 *     reconciler, and a PaymentIntent that succeeded with no row of ours
 *     becomes an unmatched payment, as the reconciler records one;
 *   - Twilio's messages since then update our texts' statuses and bring
 *     guests' replies into the inbox, each once (webhook_events).
 *
 * Every outside call happens between transactions, and only the venue's own
 * account is read; an event Stripe routes to another venue of the
 * organization is left to that venue.
 */
export interface PullDeps {
  readonly pool: pg.Pool;
  readonly clock: Clock;
  readonly stripe?: StripeClient;
  readonly venueTexts?: {
    readonly client: VenueTextClient;
    readonly secretKey: Buffer;
    readonly settings?: Pick<VenueTextSettings, "allowList">;
  };
  /** Run the stored Stripe events now as well as queueing them (the drill and the CLI). */
  readonly inline?: boolean;
}

export interface Pulled {
  stripe_events: number;
  stripe_events_queued: number;
  stripe_events_other_venue: number;
  unmatched_payments: number;
  attempts_settled: number;
  twilio_statuses: number;
  twilio_replies: number;
  skipped: string[];
}

const TWILIO_STATUS = {
  sent: "sent",
  delivered: "delivered",
  failed: "failed",
  undelivered: "failed",
} as const;

/** The endpoint an event would have reached: a reader's, else the venue's account's. */
function endpointOf(type: string): WebhookEndpoint | null {
  for (const e of ["readers", "connect"] as const) if (ENDPOINT_EVENTS[e].includes(type)) return e;
  return null;
}

async function listAll<T extends { id: string }>(
  stripe: StripeClient,
  path: string,
  account: string,
  params: Record<string, unknown>,
): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  for (let page = 0; page < 1000; page += 1) {
    const r = await stripe.call<{ data: T[]; has_more: boolean }>("payments", "GET", path, {
      account,
      params: { limit: 100, ...params, ...(after ? { starting_after: after } : {}) },
    });
    out.push(...r.data);
    if (!r.has_more || r.data.length === 0) break;
    after = r.data[r.data.length - 1]!.id;
  }
  return out;
}

/** The venue's live PaymentIntents created in [since, until], with the ones another venue recorded left out. */
export async function venueIntents(
  pool: pg.Pool,
  stripe: StripeClient,
  venueId: string,
  account: string,
  since: string,
  until: string | null,
): Promise<StripeIntent[]> {
  const from = Math.floor(Date.parse(since) / 1000);
  const to = until ? Math.floor(Date.parse(until) / 1000) : Infinity;
  const all = (
    await listAll<StripeIntent & { created?: number }>(stripe, "/v1/payment_intents", account, {
      created: { gte: from },
      expand: ["data.latest_charge"],
    })
  ).filter((pi) => (pi.created ?? from) >= from && (pi.created ?? from) <= to);
  if (all.length === 0) return [];
  const elsewhere = await withVenue(pool, { venueId, requestId: "restore:pull" }, (c) =>
    c.query<{ pis: string[] }>("select stripe_pis_elsewhere($1, $2::text[]) as pis", [
      venueId,
      all.map((pi) => pi.id),
    ]),
  );
  const theirs = new Set(elsewhere.rows[0]?.pis ?? []);
  return all.filter((pi) => !theirs.has(pi.id));
}

export async function pullSince(
  deps: PullDeps,
  venueId: string,
  restoreId: string,
  since: string,
): Promise<Pulled> {
  const out: Pulled = {
    stripe_events: 0,
    stripe_events_queued: 0,
    stripe_events_other_venue: 0,
    unmatched_payments: 0,
    attempts_settled: 0,
    twilio_statuses: 0,
    twilio_replies: 0,
    skipped: [],
  };
  const inVenue = <T>(work: (c: Queryable) => Promise<T>) =>
    withVenue(deps.pool, { venueId, requestId: `restore:${restoreId}` }, work);
  const now = deps.clock.now();

  if (!deps.stripe) out.skipped.push("no Stripe client in this environment");
  else {
    const stripe = deps.stripe;
    const account = await inVenue((c) => stripeAccountFor(c, venueId, false));
    if (!account) out.skipped.push("the venue has no Stripe account");
    else {
      // 1. Stripe's events since the restore point, oldest first, stored and run like webhooks.
      const events = (
        await listAll<{ id: string; type: string; account?: string }>(
          stripe,
          "/v1/events",
          account,
          { created: { gte: Math.floor(Date.parse(since) / 1000) } },
        )
      ).reverse();
      const handler = makeStripeEventHandler(deps.pool, stripe);
      for (const event of events) {
        const endpoint = endpointOf(event.type);
        if (!endpoint) continue;
        out.stripe_events += 1;
        const stored = await ingestStripeEvent(deps.pool, {
          eventId: event.id,
          type: event.type,
          endpoint,
          account: event.account ?? account,
          payload: { ...event, account: event.account ?? account },
        });
        if (stored.venue_id !== venueId) {
          out.stripe_events_other_venue += 1;
          continue;
        }
        if (stored.processed) continue;
        await inVenue((c) =>
          enqueue(c, {
            venueId,
            kind: STRIPE_EVENT_KIND,
            pool: endpoint === "readers" ? "critical" : "normal",
            dedupeKey: `${STRIPE_EVENT_KIND}:${event.id}`,
            payload: { webhook_event_id: stored.id },
            runAt: now,
            maxAttempts: 10,
          }),
        );
        out.stripe_events_queued += 1;
        if (deps.inline)
          await handler({
            job: {
              venue_id: venueId,
              payload: { webhook_event_id: stored.id },
            } as unknown as JobRow,
            clock: deps.clock,
            step: inVenue,
          });
      }
      // 2. Open attempts the copy brought back, settled against Stripe.
      const settled = await reconcileVenue({ pool: deps.pool, stripe, clock: deps.clock }, venueId);
      out.attempts_settled = settled.resolved.length;
      out.unmatched_payments = settled.unmatched.length;
      // 3. PaymentIntents since the restore point that succeeded with no row of ours.
      const intents = await venueIntents(deps.pool, stripe, venueId, account, since, null);
      const succeeded = intents.filter((pi) => pi.status === "succeeded");
      if (succeeded.length) {
        const known = await inVenue((c) =>
          c.query<{ id: string }>(
            "select stripe_pi_id as id from payments where venue_id = $1 and stripe_pi_id = any($2::text[])",
            [venueId, succeeded.map((pi) => pi.id)],
          ),
        );
        const ours = new Set(known.rows.map((r) => r.id));
        for (const pi of succeeded.filter((x) => !ours.has(x.id))) {
          const id = await recordUnmatched(
            { pool: deps.pool, stripe, clock: deps.clock },
            venueId,
            pi,
            now,
          );
          if (id) out.unmatched_payments += 1;
        }
      }
    }
  }

  // 4. Twilio's messages since the restore point.
  const texts = deps.venueTexts;
  if (!texts?.client.list) out.skipped.push("no Twilio client in this environment");
  else {
    const twilio = await inVenue((c) => twilioIntegration(c, venueId));
    if (!twilio) out.skipped.push("the venue has no Twilio account");
    else {
      const account = {
        accountSid: twilio.accountSid,
        authToken: decryptSecret(texts.secretKey, twilio.secretEnc),
      };
      const messages = await texts.client.list(account, new Date(since).toISOString());
      for (const m of messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        if (m.direction === "inbound") {
          const replied = await inVenue(async (c) => {
            const first = await recordWebhookEvent(c, venueId, {
              provider: "twilio",
              eventId: `${m.sid}:received`,
              type: "message.received",
              payload: { sid: m.sid, pulled: restoreId },
            });
            if (!first) return false;
            await receiveText(
              c,
              venueId,
              { from: m.from, body: m.body, sid: m.sid, now },
              texts.settings ?? { allowList: null },
            );
            return true;
          });
          if (replied) out.twilio_replies += 1;
          continue;
        }
        const status = TWILIO_STATUS[m.status as keyof typeof TWILIO_STATUS];
        if (!status) continue;
        const moved = await inVenue(async (c) => {
          const first = await recordWebhookEvent(c, venueId, {
            provider: "twilio",
            eventId: `${m.sid}:${m.status}`,
            type: "message.status",
            payload: { sid: m.sid, status: m.status, error: m.errorCode, pulled: restoreId },
          });
          if (!first) return false;
          const r = await markMessage(c, venueId, { sid: m.sid }, status);
          if (r?.changed)
            await emitEvent(c, {
              venueId,
              type: "message.updated",
              entityId: r.id,
              entityVersion: 0,
            });
          return Boolean(r?.changed);
        });
        if (moved) out.twilio_statuses += 1;
      }
    }
  }
  return out;
}
