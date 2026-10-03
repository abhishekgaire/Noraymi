import { emitEvent, statesOf, venueModules, type Queryable } from "@west4/db";
import {
  SITE_SECTIONS,
  SITE_SECTION_IDS,
  siteContentSchema,
  t,
  type ModuleId,
  type SiteContent,
  type Temporal,
} from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { attachFile, downloadLink } from "../files/storage.js";
import type { S3Settings } from "../s3.js";

/**
 * Admin → Website (M5-02; Settings · website): one draft `site_versions` row
 * the owner or a manager edits, Publish to make it live, and any earlier
 * published version published again to undo a publish. Every published
 * version is kept; the site shows the highest-numbered one.
 */
type VersionRow = {
  version: number;
  status: "draft" | "published";
  content: unknown;
  created_at: string;
  published_at: string | null;
  published_by_name: string | null;
  published_on: string | null;
};

/** Each section, whether it shows, and the module that has to be on first. */
export function sectionStates(content: SiteContent, states: Record<string, string>) {
  return SITE_SECTION_IDS.map((id) => {
    const module: ModuleId | null = SITE_SECTIONS[id];
    const moduleOn = module === null || states[module] === "on";
    return {
      id,
      module,
      module_on: moduleOn,
      shown: moduleOn && !content.hidden.includes(id),
      ...(moduleOn
        ? {}
        : { why: t("en", "website.moduleOff", { module: t("en", `module.${module!}.name`) }) }),
    };
  });
}

async function versions(c: Queryable, venueId: string) {
  return (
    await c.query<VersionRow>(
      `select s.version, s.status, s.content, s.created_at, s.published_at, u.name as published_by_name,
              (s.published_at at time zone v.time_zone)::date::text as published_on
         from site_versions s join venues v on v.id = s.venue_id
         left join users u on u.id = s.published_by
        where s.venue_id = $1 order by s.status = 'draft' desc, s.version desc`,
      [venueId],
    )
  ).rows;
}

async function photoLinks(
  c: Queryable,
  s3: () => S3Settings,
  venueId: string,
  content: SiteContent,
) {
  return Promise.all(
    content.photos.map(async (p) => ({
      ...p,
      url: await downloadLink(c, s3(), venueId, p.file_id).then(
        (l) => l.url,
        () => null,
      ),
    })),
  );
}

/** `GET /site-versions`: the draft (or the live words to start one from), every version, and each section's state. */
export async function siteVersions(c: Queryable, venueId: string, s3: () => S3Settings) {
  const rows = await versions(c, venueId);
  const draft = rows.find((r) => r.status === "draft") ?? null;
  const live = rows.find((r) => r.status === "published") ?? null;
  const base = draft ?? live;
  const content = base ? siteContentSchema.parse(base.content) : null;
  const states = statesOf(await venueModules(c, venueId));
  return {
    draft: draft ? { version: draft.version, created_at: draft.created_at } : null,
    live_version: live?.version ?? null,
    content,
    photos: content ? await photoLinks(c, s3, venueId, content) : [],
    sections: content ? sectionStates(content, states) : [],
    versions: rows
      .filter((r) => r.status === "published")
      .map((r) => ({
        version: r.version,
        published_at: r.published_at,
        /** The venue's own date it went live. */
        published_on: r.published_on,
        published_by: r.published_by_name,
        headline: siteContentSchema.parse(r.content).hero.headline,
        live: r.version === live?.version,
      })),
  };
}

/** `PUT /site-versions/draft`: save the draft. A section whose module is off can't be switched on. */
export async function saveDraft(
  c: Queryable,
  venueId: string,
  input: unknown,
  by: { userId: string | null; now: Temporal.Instant },
) {
  const parsed = siteContentSchema.safeParse(input);
  if (!parsed.success)
    throw new ApiError(
      "invalid_request",
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  const content = parsed.data;
  const rows = await versions(c, venueId);
  const before = rows[0] ? siteContentSchema.parse(rows[0].content) : null;
  const states = statesOf(await venueModules(c, venueId));
  for (const s of sectionStates(content, states)) {
    const turnedOn =
      !content.hidden.includes(s.id) && (before === null || before.hidden.includes(s.id));
    if (!s.module_on && turnedOn)
      throw new ApiError("invalid_request", s.why!, {
        details: { reason: "module_off", section: s.id },
      });
  }
  for (const photo of content.photos) {
    const file = (
      await c.query<{ kind: string }>(
        "select kind from files where venue_id = $1 and id = $2 and removed_at is null",
        [venueId, photo.file_id],
      )
    ).rows[0];
    if (file?.kind !== "site_photo")
      throw new ApiError("invalid_request", "a photo must be uploaded as a site photo", {
        details: { reason: "photo", file_id: photo.file_id },
      });
    await attachFile(c, venueId, photo.file_id, by.now);
  }
  const updated = await c.query(
    "update site_versions set content = $2 where venue_id = $1 and status = 'draft'",
    [venueId, JSON.stringify(content)],
  );
  if (updated.rowCount === 0)
    await c.query(
      `insert into site_versions (venue_id, version, status, content, created_by)
       values ($1, coalesce((select max(version) from site_versions where venue_id = $1), 0) + 1,
               'draft', $2, $3)`,
      [venueId, JSON.stringify(content), by.userId],
    );
}

async function goLive(c: Queryable, venueId: string, version: number) {
  await emitEvent(c, {
    venueId,
    type: "settings.changed",
    entityId: "site",
    entityVersion: version,
  });
  return { version };
}

/** Republishing numbers past any draft, so the draft, once published, still comes out newest. */
const nextVersion = `coalesce((select max(version) from site_versions where venue_id = $1), 0) + 1`;

/** `POST /site-versions/draft/publish`: the draft goes live as the newest version. */
export async function publishDraft(
  c: Queryable,
  venueId: string,
  by: { userId: string | null; now: Temporal.Instant },
) {
  const r = await c.query<{ version: number }>(
    `update site_versions set status = 'published',
            version = (select max(version) + 1 from site_versions where venue_id = $1 and status = 'published'),
            published_at = $2, published_by = $3
      where venue_id = $1 and status = 'draft' returning version`,
    [venueId, by.now.toString(), by.userId],
  );
  if (!r.rows[0]) throw new ApiError("not_found", "there's no draft to publish");
  return goLive(c, venueId, r.rows[0].version);
}

/** `POST /site-versions/{v}/republish`: an earlier version's words go live again, as a new version. */
export async function republish(
  c: Queryable,
  venueId: string,
  version: number,
  by: { userId: string | null; now: Temporal.Instant },
) {
  const r = await c.query<{ version: number }>(
    `insert into site_versions (venue_id, version, status, content, created_by, published_at, published_by)
     select $1, ${nextVersion}, 'published', content, $3, $4, $3
       from site_versions where venue_id = $1 and version = $2 and status = 'published'
     returning version`,
    [venueId, version, by.userId, by.now.toString()],
  );
  if (!r.rows[0]) throw new ApiError("not_found", "no such published version");
  return goLive(c, venueId, r.rows[0].version);
}
