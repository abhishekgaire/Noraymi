import { businessDate, nextBusinessDate } from "@west4/rules";
import type { Temporal } from "@west4/shared";
import { rulePackFor } from "./rule-packs.js";
import { readSetting, saveSettings } from "./settings.js";
import type { Queryable } from "./tenancy.js";

/**
 * Publishing a bar POS layout (M6-01; Staff screens and the bar POS · rule 2):
 * the draft becomes the station's next version, starting at the next business
 * date so nothing moves mid-shift, and `pos.layouts` names it from then.
 * Admin → Bar POS and the menu import (M9-04) both publish through it.
 */
export class PosLayoutRefused extends Error {
  constructor(
    readonly reason: "no_draft" | "no_pos_settings" | "no_rule_pack",
    message: string,
  ) {
    super(message);
    this.name = "PosLayoutRefused";
  }
}

export async function publishPosLayout(
  c: Queryable,
  venueId: string,
  layoutId: string,
  by: {
    userId: string | null;
    now: Temporal.Instant;
    timeZone: string;
    dayCutover: string;
  },
): Promise<{ station: string; version: number; starts_on: string }> {
  const today = businessDate(by.now, by.timeZone, by.dayCutover).businessDate;
  const startsOn = nextBusinessDate(by.now, by.timeZone, by.dayCutover);
  const r = await c.query<{ station: string; version: number }>(
    `update pos_layouts p set status = 'published',
            version = coalesce((select max(version) from pos_layouts q
                                 where q.venue_id = p.venue_id and q.station = p.station), 0) + 1,
            published_by = $3, published_at = $4, starts_on = $5
      where p.venue_id = $1 and p.id = $2 and p.status = 'draft'
      returning p.station, p.version`,
    [venueId, layoutId, by.userId, by.now.toString(), startsOn.toString()],
  );
  const published = r.rows[0];
  if (!published) throw new PosLayoutRefused("no_draft", "no draft layout with that id");
  // pos.layouts names the version in force; a layouts change starts at the next business date.
  const pos = await readSetting(c, venueId, "pos", startsOn);
  if (!pos)
    throw new PosLayoutRefused("no_pos_settings", "the bar POS settings aren't set for this venue");
  const packId =
    (
      await c.query<{ rule_pack_id: string | null }>(
        "select rule_pack_id from venues where id = $1",
        [venueId],
      )
    ).rows[0]?.rule_pack_id ?? "us-ny-new-york-county";
  const pack = await rulePackFor(c, packId, today);
  if (!pack) throw new PosLayoutRefused("no_rule_pack", `no usable rule pack ${packId}`);
  await saveSettings(c, {
    venueId,
    values: {
      pos: {
        ...pos.value,
        layouts: { ...pos.value.layouts, [published.station]: published.version },
      },
    },
    savedBy: by.userId ?? undefined,
    today,
    check: { pack: pack.pack, cutover: by.dayCutover },
  });
  return { station: published.station, version: published.version, starts_on: startsOn.toString() };
}
