import { defaultPermissions } from "@west4/shared";
import type { Queryable } from "./tenancy.js";

/** One browser's push subscription on a paired staff phone (M1-22). */
export interface PushSubscriptionRow {
  readonly id: string;
  readonly device_id: string;
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
  readonly created_at: string;
  readonly revoked_at: string | null;
}

/** A live subscription with the phone owner's language, for rendering the words. */
export interface PushTargetRow extends PushSubscriptionRow {
  readonly locale: "en" | "es";
}

const COLS = "id, device_id, endpoint, keys, created_at::text, revoked_at::text";

/** Save (or refresh) a subscription for a device. The same endpoint again updates the keys and revives it. */
export async function savePushSubscription(
  client: Queryable,
  args: {
    readonly venueId: string;
    readonly deviceId: string;
    readonly endpoint: string;
    readonly keys: { readonly p256dh: string; readonly auth: string };
  },
): Promise<PushSubscriptionRow> {
  const r = await client.query<PushSubscriptionRow>(
    `insert into push_subscriptions (venue_id, device_id, endpoint, keys)
     values ($1, $2, $3, $4)
     on conflict (venue_id, endpoint) do update
       set device_id = excluded.device_id, keys = excluded.keys, revoked_at = null
     returning ${COLS}`,
    [args.venueId, args.deviceId, args.endpoint, JSON.stringify(args.keys)],
  );
  return r.rows[0]!;
}

/** Who gets a push: one person's phones, or every phone of a role at the venue. */
export type PushAudience =
  | { readonly kind: "person"; readonly userId: string }
  | { readonly kind: "role"; readonly role: string }
  /** Every staff phone at the venue (room calls, M2-20). */
  | { readonly kind: "everyone" }
  /**
   * The bar-role people on the clock (M7-01): bartenders, and the front desk
   * while Admin lets it cover the bar (its pos.use switch). Phones of people
   * not clocked in stay quiet.
   */
  | { readonly kind: "bar_on_clock" };

/** Live subscriptions on live, paired staff phones for the audience. A revoked device's subscription is never returned. */
export async function activePushSubscriptions(
  client: Queryable,
  venueId: string,
  audience: PushAudience,
): Promise<PushTargetRow[]> {
  const base = `select s.id, s.device_id, s.endpoint, s.keys, s.created_at::text, s.revoked_at::text, m.locale
     from push_subscriptions s
     join devices d on d.id = s.device_id and d.venue_id = s.venue_id
     join memberships m on m.venue_id = d.venue_id and m.user_id = d.user_id and m.status = 'active'
     where s.venue_id = $1 and s.revoked_at is null
       and d.kind = 'staff_phone' and d.revoked_at is null and d.disabled_at is null`;
  if (audience.kind === "everyone")
    return (await client.query<PushTargetRow>(`${base} order by s.created_at`, [venueId])).rows;
  if (audience.kind === "bar_on_clock") {
    const override = await client.query<{ allowed: boolean }>(
      "select allowed from role_permissions where venue_id = $1 and role = 'front_desk' and action = 'pos.use'",
      [venueId],
    );
    const covers = override.rows[0]?.allowed ?? defaultPermissions["pos.use"].front_desk;
    const roles = covers ? ["bartender", "front_desk"] : ["bartender"];
    return (
      await client.query<PushTargetRow>(
        `${base} and m.role = any($2::text[])
           and exists (select 1 from shifts sh where sh.venue_id = m.venue_id and sh.membership_id = m.id
                         and sh.ended_at is null)
         order by s.created_at`,
        [venueId, roles],
      )
    ).rows;
  }
  const r =
    audience.kind === "person"
      ? await client.query<PushTargetRow>(`${base} and d.user_id = $2 order by s.created_at`, [
          venueId,
          audience.userId,
        ])
      : await client.query<PushTargetRow>(`${base} and m.role = $2 order by s.created_at`, [
          venueId,
          audience.role,
        ]);
  return r.rows;
}

/** The push service said the subscription is gone (404 or 410): stop sending to it. */
export async function revokePushSubscription(
  client: Queryable,
  venueId: string,
  id: string,
): Promise<void> {
  await client.query(
    "update push_subscriptions set revoked_at = coalesce(revoked_at, now()) where venue_id = $1 and id = $2",
    [venueId, id],
  );
}
