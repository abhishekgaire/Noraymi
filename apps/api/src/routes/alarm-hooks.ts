import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { withVenue } from "@west4/db";
import type { Clock, Temporal } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { venueOpenNow } from "../jobs/device-watch.js";
import { alertRule, type AlertRuleId } from "../ops/alert-rules.js";
import { clearKey, raisePage } from "../ops/paging.js";
import {
  fetchCert,
  isAmazonUrl,
  parseSns,
  readAlarm,
  verifySns,
  type CertFetcher,
} from "../ops/sns.js";

/**
 * The alarm hook (M8-17): the pages topic (infra/staging/paging.tf) posts CloudWatch alarms and
 * RDS failover events here. A burn-rate alarm pages us only while some venue is inside its opening
 * hours (outside them it opens a ticket-severity page nobody is woken for); OK clears it. A
 * failover pages once per SNS message. Anything not signed by Amazon for PAGES_TOPIC_ARN is
 * refused, and with PAGES_TOPIC_ARN unset the hook is off.
 */
export interface AlarmHookOptions {
  readonly pool: pg.Pool;
  readonly clock: Clock;
  readonly topicArn?: string | null;
  readonly getCert?: CertFetcher;
  /** Confirms the topic's subscription (a GET to Amazon's SubscribeURL); outside any transaction. */
  readonly confirm?: (url: string) => Promise<void>;
}

export async function anyVenueOpen(pool: pg.Pool, now: Temporal.Instant): Promise<boolean> {
  const venues = await pool.query<{ id: string; time_zone: string; day_cutover: string }>(
    "select id, time_zone, to_char(day_cutover, 'HH24:MI') as day_cutover from venues_for_scheduler()",
  );
  for (const v of venues.rows)
    if (
      await withVenue(pool, { venueId: v.id, requestId: "alarm-hook" }, (c) =>
        venueOpenNow(c, v, now),
      )
    )
      return true;
  return false;
}

export function alarmHookRoutes(app: FastifyInstance, options: AlarmHookOptions): void {
  const topicArn =
    options.topicArn === undefined ? (process.env["PAGES_TOPIC_ARN"] ?? null) : options.topicArn;
  const confirm =
    options.confirm ??
    (async (url: string) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`subscription confirmation: ${res.status}`);
    });

  void app.register(async (hooks) => {
    hooks.removeContentTypeParser("application/json");
    hooks.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) =>
      done(null, body),
    );
    hooks.post<{ Body: unknown }>(
      "/v1/hooks/alarms",
      {
        config: route({
          principals: ["public"],
          module: "core",
          idempotency: "none",
          rateLimit: { max: 120, windowMs: 60_000 },
        }),
      },
      async (request, reply) => {
        if (!topicArn) throw new ApiError("not_found", "the alarm hook isn't set up here");
        const m = parseSns(request.body);
        if (!m || m.TopicArn !== topicArn)
          throw new ApiError("unauthorized", "not a message from the pages topic");
        if (!(await verifySns(m, options.getCert ?? fetchCert)))
          throw new ApiError("unauthorized", "the signature doesn't verify");

        if (m.Type === "SubscriptionConfirmation") {
          if (!m.SubscribeURL || !isAmazonUrl(m.SubscribeURL))
            throw new ApiError("invalid_request", "no SubscribeURL from Amazon");
          await confirm(m.SubscribeURL);
          return reply.code(200).send({ confirmed: true });
        }
        if (m.Type !== "Notification") return reply.code(200).send({ ignored: true });

        const now = options.clock.now();
        const event = readAlarm(m.Message);
        if (event.kind === "rds") {
          const made = await raisePage(
            options.pool,
            {
              rule: "db-failover",
              key: `db-failover:${m.MessageId}`,
              summary: `Database ${event.source}: ${event.message || "failover"}`,
            },
            now,
          );
          return reply.code(200).send({ page: made?.page.id ?? null });
        }
        if (event.kind !== "alarm" || !event.rule) return reply.code(200).send({ ignored: true });
        const rule = alertRule(event.rule);
        if (!rule || rule.audience !== "us" || !rule.sources.includes("cloudwatch"))
          return reply.code(200).send({ ignored: true });
        const key = `cw:${event.name}`;
        if (event.state === "OK") {
          await clearKey(options.pool, key, now);
          return reply.code(200).send({ cleared: true });
        }
        if (event.state !== "ALARM") return reply.code(200).send({ ignored: true });
        // Burn rates count during opening hours only (M8-16's note): outside them, a ticket.
        const severity =
          rule.id === "target-burn" && !(await anyVenueOpen(options.pool, now)) ? "ticket" : "page";
        const made = await raisePage(
          options.pool,
          {
            rule: rule.id as AlertRuleId,
            key,
            summary: `${rule.title}: ${event.name}`,
            severity,
          },
          now,
        );
        return reply.code(200).send({ page: made?.page.id ?? null, severity });
      },
    );
  });
}
