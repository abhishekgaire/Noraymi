import { PosLayoutRefused, publishPosLayout, readSetting, type Queryable } from "@west4/db";
import { businessDate } from "@west4/rules";
import {
  POS_SECTIONS,
  posLayoutSectionsSchema,
  type PosLayoutSections,
  type Temporal,
} from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { venueClock } from "../rooms/assignment.js";

/**
 * Bar POS layouts (M6-01; Staff screens and the bar POS · rule 2; Settings ·
 * pos.layouts, When a change starts): one draft per station; publishing makes
 * it the station's next version, starting at the next business date, so the
 * bar keeps tonight's buttons until the 6:00 AM cutover.
 */
interface Row {
  id: string;
  version: number | null;
  status: "draft" | "published";
  sections: PosLayoutSections;
  published_at: string | null;
  published_by: string | null;
  starts_on: string | null;
}

async function rows(c: Queryable, venueId: string, station: string): Promise<Row[]> {
  return (
    await c.query<Row>(
      `select p.id, p.version, p.status, p.sections, to_json(p.published_at) #>> '{}' as published_at,
              u.name as published_by, p.starts_on::text
         from pos_layouts p left join users u on u.id = p.published_by
        where p.venue_id = $1 and p.station = $2
        order by p.status = 'draft' desc, p.version desc`,
      [venueId, station],
    )
  ).rows;
}

/** `GET /pos/layouts?station=`: tonight's layout, the next one if one is waiting, the draft, every version. */
export async function layoutsView(
  c: Queryable,
  venueId: string,
  station: string,
  now: Temporal.Instant,
) {
  const venue = await venueClock(c, venueId);
  const today = businessDate(now, venue.timeZone, venue.dayCutover).businessDate;
  const tomorrow = today.add({ days: 1 });
  const [tonightPos, nextPos] = await Promise.all([
    readSetting(c, venueId, "pos", today),
    readSetting(c, venueId, "pos", tomorrow),
  ]);
  const all = await rows(c, venueId, station);
  const byVersion = (v: number | undefined) =>
    v === undefined ? null : (all.find((r) => r.version === v) ?? null);
  const tonight = byVersion(tonightPos?.value.layouts[station]);
  const next = byVersion(nextPos?.value.layouts[station]);
  const draft = all.find((r) => r.status === "draft") ?? null;
  return {
    station,
    business_date: today.toString(),
    sections: POS_SECTIONS,
    tonight: tonight
      ? { id: tonight.id, version: tonight.version, sections: tonight.sections }
      : null,
    next:
      next && next.version !== tonight?.version
        ? { id: next.id, version: next.version, starts_on: tomorrow.toString() }
        : null,
    draft: draft ? { id: draft.id, sections: draft.sections } : null,
    versions: all
      .filter((r) => r.status === "published")
      .map((r) => ({
        id: r.id,
        version: r.version,
        published_at: r.published_at,
        published_by: r.published_by,
        starts_on: r.starts_on,
      })),
  };
}

/** `POST /pos/layouts`: save the station's draft. Every item has to be one of this venue's. */
export async function saveLayoutDraft(
  c: Queryable,
  venueId: string,
  input: { station: string; sections: unknown; userId: string | null },
) {
  const parsed = posLayoutSectionsSchema.safeParse(input.sections);
  if (!parsed.success)
    throw new ApiError("invalid_request", "ten sections of 25 slots, each an item id or empty", {
      details: { reason: "shape" },
    });
  const ids = [
    ...new Set(
      Object.values(parsed.data)
        .flat()
        .filter((x): x is string => x !== null),
    ),
  ];
  if (ids.length > 0) {
    const known = await c.query<{ id: string }>(
      "select id from menu_items where venue_id = $1 and id = any($2::uuid[])",
      [venueId, ids],
    );
    if (known.rows.length !== ids.length)
      throw new ApiError(
        "invalid_request",
        "the layout names an item that isn't on this venue's menu",
        {
          details: { reason: "unknown_item" },
        },
      );
  }
  const updated = await c.query<{ id: string }>(
    `update pos_layouts set sections = $3 where venue_id = $1 and station = $2 and status = 'draft' returning id`,
    [venueId, input.station, JSON.stringify(parsed.data)],
  );
  if (updated.rows[0]) return updated.rows[0].id;
  return (
    await c.query<{ id: string }>(
      `insert into pos_layouts (venue_id, station, status, sections, created_by)
       values ($1, $2, 'draft', $3, $4) returning id`,
      [venueId, input.station, JSON.stringify(parsed.data), input.userId],
    )
  ).rows[0]!.id;
}

/** `POST /pos/layouts/{l}/publish`: the draft becomes the next version, starting at the next business date. */
export async function publishLayout(
  c: Queryable,
  venueId: string,
  layoutId: string,
  by: { userId: string | null; now: Temporal.Instant },
) {
  const venue = await venueClock(c, venueId);
  try {
    return await publishPosLayout(c, venueId, layoutId, { ...by, ...venue });
  } catch (error) {
    if (!(error instanceof PosLayoutRefused)) throw error;
    if (error.reason === "no_draft") throw new ApiError("not_found", error.message);
    if (error.reason === "no_pos_settings") throw new ApiError("invalid_request", error.message);
    throw new ApiError("internal", error.message);
  }
}
