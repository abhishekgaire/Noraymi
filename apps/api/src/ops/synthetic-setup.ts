import { webcrypto } from "node:crypto";
import type pg from "pg";
import { withVenue } from "@west4/db";
import { DEVICE_KEY_ALGORITHM } from "@west4/shared";
import { SYNTHETIC_FLAG, syntheticConfigSchema, type SyntheticConfig } from "./synthetic.js";

/**
 * Making a venue our own test venue for the synthetic check (M8-18). The venue itself is made the
 * normal way (Console onboarding, in our own organization), with a room, something without alcohol
 * on the menu, a simulated reader registered in training (Admin → Devices, `practice`), the same
 * hours as the live venues, and a bartender with a PIN. This then turns the venue's
 * `synthetic.test_venue` flag on, pairs a synthetic bar computer in training mode with a fresh key,
 * and answers the SYNTHETIC_CHECK secret. It refuses a venue that has ever had a live check: a real
 * venue is never a test venue.
 */
export class NotATestVenue extends Error {}

export async function setupSyntheticVenue(
  pool: pg.Pool,
  args: {
    readonly venueId: string;
    readonly membershipId: string;
    readonly pin: string;
    readonly apiUrl: string;
    readonly by: string;
  },
): Promise<SyntheticConfig> {
  const key = await webcrypto.subtle.generateKey(DEVICE_KEY_ALGORITHM, true, ["sign", "verify"]);
  const publicJwk = await webcrypto.subtle.exportKey("jwk", key.publicKey);
  const privateJwk = await webcrypto.subtle.exportKey("jwk", key.privateKey);
  return withVenue(pool, { venueId: args.venueId, requestId: "synthetic-setup" }, async (c) => {
    const venue = (
      await c.query<{ slug: string }>("select slug from venues where id = $1", [args.venueId])
    ).rows[0];
    if (!venue) throw new NotATestVenue("no such venue");
    const live = await c.query<{ n: number }>(
      "select count(*)::int as n from checks where venue_id = $1 and not training",
      [args.venueId],
    );
    if (live.rows[0]!.n > 0)
      throw new NotATestVenue("this venue has live checks: a real venue is never a test venue");
    const member = await c.query(
      `select 1 from memberships where venue_id = $1 and id = $2 and status = 'active'
          and pin_verifier is not null`,
      [args.venueId, args.membershipId],
    );
    if (member.rowCount === 0)
      throw new NotATestVenue("the membership isn't active at this venue with a PIN set");
    const pick = async (what: string, sql: string) => {
      const r = await c.query<{ id: string }>(sql, [args.venueId]);
      if (!r.rows[0]) throw new NotATestVenue(`the venue needs ${what} first`);
      return r.rows[0].id;
    };
    const roomId = await pick(
      "a room",
      "select id from rooms where venue_id = $1 and archived_at is null order by name limit 1",
    );
    const readerId = await pick(
      "a simulated reader registered in training (Admin → Devices)",
      `select id from devices where venue_id = $1 and kind = 'reader' and sandbox
          and stripe_reader_id is not null and revoked_at is null order by name limit 1`,
    );
    const variantId = await pick(
      "something without alcohol on the menu",
      `select v.id from menu_variants v join menu_items i on i.venue_id = v.venue_id and i.id = v.item_id
        where v.venue_id = $1 and not i.alcohol and i.shown and v.price_cents > 0
        order by i.name, v.sort limit 1`,
    );
    await c.query(
      `insert into venue_flags (venue_id, flag, "on", set_by) values ($1, $2, true, $3)
       on conflict (venue_id, flag) do update set "on" = true, set_by = $3, set_at = now()`,
      [args.venueId, SYNTHETIC_FLAG, args.by.slice(0, 100)],
    );
    const device = await c.query<{ id: string }>(
      `insert into devices (venue_id, kind, name, public_key, training)
       values ($1, 'bar_computer', 'Synthetic bar', $2, true) returning id`,
      [args.venueId, JSON.stringify(publicJwk)],
    );
    return syntheticConfigSchema.parse({
      api_url: args.apiUrl,
      venue_id: args.venueId,
      venue_slug: venue.slug,
      device_id: device.rows[0]!.id,
      device_key: privateJwk,
      membership_id: args.membershipId,
      pin: args.pin,
      room_id: roomId,
      reader_id: readerId,
      variant_id: variantId,
    });
  });
}
