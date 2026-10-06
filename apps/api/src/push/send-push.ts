import { z } from "zod";
import {
  activePushSubscriptions,
  enqueue,
  revokePushSubscription,
  type JobHandler,
  type PushAudience,
  type Queryable,
} from "@west4/db";
import {
  catalogs,
  t,
  type Locale,
  type MessageKey,
  type MessageParams,
  type Temporal,
} from "@west4/shared";
import type { PushSender } from "./sender.js";

/**
 * One push to an audience (M1-22): a person's phones, or every phone of a
 * role at the venue (M2-15 adds "the manager on duty"). The job resolves the
 * live subscriptions in one short transaction, sends outside any transaction,
 * and revokes a subscription the push service says is gone. The words are a
 * catalog key, rendered in each phone owner's own language.
 */
export const PUSH_SEND_KIND = "push.send";

const messageKey = z.string().refine((k): k is MessageKey => k in catalogs.en, "not a catalog key");

export const pushJobPayload = z
  .object({
    audience: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("person"), user_id: z.string().uuid() }).strict(),
      z.object({ kind: z.literal("role"), role: z.string().min(1) }).strict(),
      z.object({ kind: z.literal("everyone") }).strict(),
      z.object({ kind: z.literal("bar_on_clock") }).strict(),
    ]),
    message: z
      .object({
        key: messageKey,
        params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
        /** Where the tap opens, a path in the staff app. */
        url: z.string().max(200).optional(),
        /** Replaces an earlier push with the same tag instead of stacking. */
        tag: z.string().max(80).optional(),
      })
      .strict(),
  })
  .strict();

export type PushJobPayload = z.infer<typeof pushJobPayload>;

export async function enqueuePush(
  client: Queryable,
  args: {
    readonly venueId: string;
    readonly audience: PushAudience;
    readonly message: PushJobPayload["message"];
    readonly runAt: Temporal.Instant;
    readonly dedupeKey?: string;
  },
): Promise<string | null> {
  const payload: PushJobPayload = {
    audience:
      args.audience.kind === "person"
        ? { kind: "person", user_id: args.audience.userId }
        : args.audience.kind === "everyone" || args.audience.kind === "bar_on_clock"
          ? { kind: args.audience.kind }
          : { kind: "role", role: args.audience.role },
    message: args.message,
  };
  return enqueue(client, {
    venueId: args.venueId,
    kind: PUSH_SEND_KIND,
    pool: "normal",
    runAt: args.runAt,
    payload,
    dedupeKey: args.dedupeKey,
    maxAttempts: 3,
  });
}

/** What the service worker shows: the venue as the title, the catalog string as the body. */
export function renderPush(
  venueName: string,
  locale: Locale,
  message: PushJobPayload["message"],
): string {
  return JSON.stringify({
    title: venueName,
    body: t(locale, message.key, message.params as MessageParams | undefined),
    url: message.url ?? "/",
    tag: message.tag ?? message.key,
  });
}

export function makePushSendHandler(sender: PushSender): JobHandler {
  return async ({ job, step }) => {
    const payload = pushJobPayload.parse(job.payload);
    const audience: PushAudience =
      payload.audience.kind === "person"
        ? { kind: "person", userId: payload.audience.user_id }
        : payload.audience.kind === "everyone" || payload.audience.kind === "bar_on_clock"
          ? { kind: payload.audience.kind }
          : { kind: "role", role: payload.audience.role };
    const { venueName, targets } = await step(async (c) => {
      const venue = await c.query<{ name: string }>("select name from venues where id = $1", [
        job.venue_id,
      ]);
      const subscriptions = await activePushSubscriptions(c, job.venue_id, audience);
      return { venueName: venue.rows[0]?.name ?? "", targets: subscriptions };
    });
    for (const target of targets) {
      // Outside any transaction: the push service is an outside call.
      const result = await sender.send(
        target,
        renderPush(venueName, target.locale, payload.message),
      );
      if (!result.ok && result.gone) {
        await step((c) => revokePushSubscription(c, job.venue_id, target.id));
      }
    }
  };
}
