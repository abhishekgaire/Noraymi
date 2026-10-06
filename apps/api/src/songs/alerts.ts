import { z } from "zod";
import { enqueue, readSetting, type JobHandler, type Queryable } from "@west4/db";
import { t, type Temporal } from "@west4/shared";
import { TEXT_TRIGGER_KIND } from "../texts/triggers.js";
import type { PushSender } from "../push/sender.js";
import { nightOf, queueView } from "./queue.js";
import { barModeState } from "./public.js";

/**
 * Singer alerts (M6-21; spec 11 · Alerts and The automatic texts #12; D62). After every Started and
 * Skip (and when a singer's phone turns alerts on), each queued singer's place is worked out again as
 * the singers still to start before their next song:
 *   at `barMode.alerts.beforeYou` (2), a push: "2 singers before you";
 *   when the singer before them starts (none left to start, someone singing), a push "You're up next at
 *     the bar · come to the stage", and with `upNextText` on, the You're up next service text.
 * Each alert goes once per queued song: its job's dedupe key carries the song's id. The text goes through
 * the automatic texts' trigger job, so a STOP, the template switched off or Guest texts off stops it there,
 * while the push still goes. With bar mode off nothing is planned.
 */
export const SINGER_PUSH_KIND = "singer.push";

export type SingerAlert = "before" | "up_next";

const payload = z
  .object({
    singer_id: z.string().uuid(),
    queue_id: z.string().uuid(),
    alert: z.enum(["before", "up_next"]),
    count: z.number().int().nonnegative(),
  })
  .strict();

/** The singers still to start before each singer's next queued song, with that song. */
export function placesOf(view: Awaited<ReturnType<typeof queueView>>) {
  const seen = new Set<string>();
  const out: { singerId: string; queueId: string; before: number }[] = [];
  for (const song of view.up_next) {
    if (!out.some((o) => o.singerId === song.singer_id))
      out.push({ singerId: song.singer_id, queueId: song.id, before: seen.size });
    seen.add(song.singer_id);
  }
  return out;
}

/** Plans the alerts the queue calls for now; returns the dedupe keys of the jobs it queued. */
export async function planSingerAlerts(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
  only?: string,
): Promise<string[]> {
  if ((await barModeState(c, venueId)) !== "on") return [];
  const date = await nightOf(c, venueId, now);
  const alerts = (await readSetting(c, venueId, "barMode", date))?.value.alerts ?? {
    beforeYou: 2,
    upNextText: true,
  };
  const view = await queueView(c, venueId, now);
  const queued: string[] = [];
  for (const p of placesOf(view)) {
    if (only && p.singerId !== only) continue;
    const upNext = p.before === 0 && view.singing !== null && view.singing.singer_id !== p.singerId;
    const before = alerts.beforeYou > 0 && p.before === alerts.beforeYou;
    if (!upNext && !before) continue;
    const alert: SingerAlert = upNext ? "up_next" : "before";
    const key = `singer-alert:${alert}:${p.queueId}`;
    const id = await enqueue(c, {
      venueId,
      kind: SINGER_PUSH_KIND,
      pool: "normal",
      runAt: now,
      dedupeKey: key,
      maxAttempts: 3,
      payload: { singer_id: p.singerId, queue_id: p.queueId, alert, count: p.before },
    });
    if (!id) continue;
    queued.push(key);
    if (upNext && alerts.upNextText) {
      const phone = (
        await c.query<{ phone_e164: string }>(
          "select phone_e164 from singers where venue_id = $1 and id = $2",
          [venueId, p.singerId],
        )
      ).rows[0]?.phone_e164;
      if (phone)
        await enqueue(c, {
          venueId,
          kind: TEXT_TRIGGER_KIND,
          pool: "normal",
          runAt: now,
          dedupeKey: `text:up_next:${p.queueId}`,
          payload: {
            template_key: "up_next",
            to: phone,
            params: {},
            guest_id: null,
            context: null,
          },
        });
    }
  }
  return queued;
}

/** What the queue page's service worker shows: the venue as the title, the alert as the body. */
export function renderSingerPush(
  venueName: string,
  slug: string,
  alert: SingerAlert,
  count: number,
): string {
  return JSON.stringify({
    title: venueName,
    body:
      alert === "up_next"
        ? t("en", "guestSing.upNextAlert")
        : count === 1
          ? t("en", "guestSing.before.one")
          : t("en", "guestSing.before.many", { count }),
    url: `/v/${slug}/sing`,
    tag: `sing-${alert}`,
  });
}

/**
 * Sends one alert to the singer's phones: the song still queued and the subscriptions read in one short
 * transaction, the pushes sent outside any transaction, and a subscription the push service says is gone
 * revoked.
 */
export function makeSingerPushHandler(sender: PushSender): JobHandler {
  return async ({ job, step }) => {
    const p = payload.parse(job.payload);
    const found = await step(async (c) => {
      const song = await c.query(
        "select 1 from song_queue where venue_id = $1 and id = $2 and singer_id = $3 and status = 'queued'",
        [job.venue_id, p.queue_id, p.singer_id],
      );
      if (!song.rowCount) return null;
      const venue = (
        await c.query<{ name: string; slug: string }>(
          "select name, slug from venues where id = $1",
          [job.venue_id],
        )
      ).rows[0];
      const subs = await c.query<{
        id: string;
        endpoint: string;
        keys: { p256dh: string; auth: string };
      }>(
        `select id, endpoint, keys from singer_push_subscriptions
          where venue_id = $1 and singer_id = $2 and revoked_at is null order by created_at, id`,
        [job.venue_id, p.singer_id],
      );
      return venue ? { venue, subs: subs.rows } : null;
    });
    if (!found) return;
    const body = renderSingerPush(found.venue.name, found.venue.slug, p.alert, p.count);
    for (const target of found.subs) {
      // Outside any transaction: the push service is an outside call.
      const result = await sender.send(target, body);
      if (!result.ok && result.gone)
        await step((c) =>
          c.query(
            "update singer_push_subscriptions set revoked_at = coalesce(revoked_at, now()) where venue_id = $1 and id = $2",
            [job.venue_id, target.id],
          ),
        );
    }
  };
}

/** The singer's phone allows alerts: its subscription is kept (or refreshed) for this singer. */
export async function saveSingerSubscription(
  c: Queryable,
  venueId: string,
  input: {
    singerId: string;
    endpoint: string;
    keys: { p256dh: string; auth: string };
    now: Temporal.Instant;
  },
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `insert into singer_push_subscriptions (venue_id, singer_id, endpoint, keys, created_at)
     values ($1, $2, $3, $4, $5)
     on conflict (venue_id, endpoint) do update
       set singer_id = excluded.singer_id, keys = excluded.keys, revoked_at = null
     returning id`,
    [venueId, input.singerId, input.endpoint, JSON.stringify(input.keys), input.now.toString()],
  );
  return r.rows[0]!.id;
}
