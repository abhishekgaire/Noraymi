import { GetObjectCommand } from "@aws-sdk/client-s3";
import type pg from "pg";
import { withVenue, type Queryable } from "@west4/db";
import type { Temporal } from "@west4/shared";
import { attachFile } from "../files/storage.js";
import { ApiError } from "../http/errors.js";
import type { S3Settings } from "../s3.js";
import { parseSongbook, songbookText, type SongbookError } from "./songbook-csv.js";

/**
 * The songbook (M6-23; Song systems and texts · Songbook; D63). The KJ uploads a CSV (title, artist,
 * code) through POST /files, then POST /songbook/uploads loads it into `song_catalog`: every row is
 * checked, and only a file whose every row passes replaces the last upload, so a bad file never
 * empties a good songbook. Search reads the current songs through the trigram index on title and
 * artist. A vendor's own catalog file needs its written agreement first; nothing is ever scraped.
 */

/** At most this many failing rows go back; the count says how many there were. */
const ERRORS_SHOWN = 100;
const CHUNK = 2000;

export interface SongbookSummary {
  readonly songs: number;
  readonly file_id: string | null;
  readonly loaded_at: string | null;
}

export async function songbookSummary(c: Queryable, venueId: string): Promise<SongbookSummary> {
  const r = (
    await c.query<{ songs: number; file_id: string | null; loaded_at: string | null }>(
      `select count(*)::int as songs, max(source_file_id::text) as file_id, max(loaded_at) as loaded_at
         from song_catalog where venue_id = $1 and replaced_at is null`,
      [venueId],
    )
  ).rows[0]!;
  return {
    songs: r.songs,
    file_id: r.file_id,
    loaded_at: r.loaded_at ? new Date(r.loaded_at).toISOString() : null,
  };
}

/** Whether the venue has a songbook to search. */
export async function hasCatalog(c: Queryable, venueId: string): Promise<boolean> {
  return (
    (
      await c.query(
        "select 1 from song_catalog where venue_id = $1 and replaced_at is null limit 1",
        [venueId],
      )
    ).rowCount === 1
  );
}

export interface FoundSong {
  readonly id: string;
  readonly title: string;
  readonly artist: string | null;
}

/** Title and artist, best match first: a part of either, or a near spelling of a word in them. */
export async function searchSongs(
  c: Queryable,
  venueId: string,
  q: string,
  limit = 20,
): Promise<FoundSong[]> {
  const text = q.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 100);
  if (text.length < 2) return [];
  const like = `%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  return (
    await c.query<FoundSong>(
      `select id, title, artist from song_catalog
        where venue_id = $1 and replaced_at is null and (search like $2 or $3 <% search)
        order by (search like $2) desc, word_similarity($3, search) desc, title, artist
        limit $4`,
      [venueId, like, text, limit],
    )
  ).rows;
}

/** A song picked from the songbook, for the queue: its title and artist as the catalog has them. */
export async function catalogSong(c: Queryable, venueId: string, id: string) {
  return (
    await c.query<{ title: string; artist: string | null }>(
      "select title, artist from song_catalog where venue_id = $1 and id = $2 and replaced_at is null",
      [venueId, id],
    )
  ).rows[0];
}

export interface SongbookLoad {
  readonly songs: number;
  readonly file_id: string;
  readonly loaded_at: string;
}

/**
 * Load an uploaded songbook file. The file is read from storage outside any transaction; the rows
 * that fail come back with their line numbers (reason `rows`), and the last upload stays.
 */
export async function loadSongbook(
  pool: pg.Pool,
  s3: S3Settings,
  input: { venueId: string; fileId: string; now: Temporal.Instant; requestId?: string },
): Promise<SongbookLoad> {
  const ctx = { venueId: input.venueId, requestId: input.requestId ?? "songbook" };
  const file = await withVenue(
    pool,
    ctx,
    async (c) =>
      (
        await c.query<{ storage_key: string }>(
          `select storage_key from files
          where venue_id = $1 and id = $2 and kind = 'songbook' and removed_at is null`,
          [input.venueId, input.fileId],
        )
      ).rows[0],
  );
  if (!file) throw new ApiError("not_found", "no such songbook file");
  let bytes: Uint8Array;
  try {
    const object = await s3.client.send(
      new GetObjectCommand({ Bucket: s3.bucketFiles, Key: file.storage_key }),
    );
    bytes = await object.Body!.transformToByteArray();
  } catch {
    throw new ApiError("invalid_request", "the file hasn't reached storage; upload it again", {
      details: { reason: "not_uploaded" },
    });
  }
  const text = songbookText(bytes);
  const parsed =
    text === null
      ? { ok: false as const, errors: [{ line: 0, problem: "not_utf8" } as SongbookError] }
      : parseSongbook(text);
  if (!parsed.ok)
    throw new ApiError("invalid_request", "some rows of the songbook can't be loaded", {
      details: {
        reason: "rows",
        count: parsed.errors.length,
        errors: parsed.errors.slice(0, ERRORS_SHOWN),
      },
    });
  const songs = parsed.songs;
  const at = input.now.toString();
  await withVenue(pool, ctx, async (c) => {
    // One upload at a time per venue, so two at once can't both stay current.
    await c.query("select pg_advisory_xact_lock(hashtext('songbook:' || $1))", [input.venueId]);
    await c.query(
      `update song_catalog set replaced_at = $2
        where venue_id = $1 and vendor = 'songbook' and replaced_at is null`,
      [input.venueId, at],
    );
    for (let i = 0; i < songs.length; i += CHUNK) {
      const part = songs.slice(i, i + CHUNK);
      await c.query(
        `insert into song_catalog (venue_id, vendor, vendor_code, title, artist, source_file_id, loaded_at)
         select $1, 'songbook', s.code, s.title, s.artist, $2, $3
           from unnest($4::text[], $5::text[], $6::text[]) as s (title, artist, code)`,
        [
          input.venueId,
          input.fileId,
          at,
          part.map((s) => s.title),
          part.map((s) => s.artist),
          part.map((s) => s.code),
        ],
      );
    }
    await attachFile(c, input.venueId, input.fileId, input.now);
  });
  return { songs: songs.length, file_id: input.fileId, loaded_at: at };
}
