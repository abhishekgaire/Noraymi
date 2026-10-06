import { createHash, randomBytes } from "node:crypto";
import { venueModules, type Queryable } from "@west4/db";
import type { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { queueSong, queueView, sendCode, verifySinger } from "./queue.js";

/**
 * The singer's queue page (M6-20; Song systems and texts · Bar mode: Joining, Alerts, Screens;
 * Tenancy and access · Singer in the bar queue). A singer joins from their phone with a display name
 * and a number confirmed once by a code; the right code hands their phone a token (128 bits, only its
 * hash stored) that reaches their own songs and nothing else. A number already confirmed here signs
 * that singer in again with a fresh code, so a new phone never makes a second singer. Nothing here
 * returns a phone number, and the queue shows the names the Up next TV shows.
 */
export const singerTokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Bar mode's state here: the page reads while it isn't off, and joins and queues only while it's on. */
export async function barModeState(c: Queryable, venueId: string) {
  return (await venueModules(c, venueId)).find((m) => m.module_id === "bar_mode")?.state ?? "off";
}

/** A code texted to the number: to the singer who already has it confirmed here, or to a new one. */
export async function requestSingerCode(
  c: Queryable,
  venueId: string,
  input: { displayName: string; phoneE164: string; locale: "en" | "es"; now: Temporal.Instant },
): Promise<void> {
  const known = (
    await c.query<{ id: string }>(
      `select id from singers where venue_id = $1 and phone_e164 = $2 and phone_verified_at is not null
        for update`,
      [venueId, input.phoneE164],
    )
  ).rows[0];
  let id = known?.id;
  if (!id) {
    const pending = (
      await c.query<{ id: string }>(
        `select id from singers where venue_id = $1 and phone_e164 = $2 and phone_verified_at is null
          order by joined_at desc, id limit 1 for update`,
        [venueId, input.phoneE164],
      )
    ).rows[0];
    if (pending) {
      id = pending.id;
      await c.query("update singers set display_name = $3 where venue_id = $1 and id = $2", [
        venueId,
        id,
        input.displayName,
      ]);
    } else {
      id = (
        await c.query<{ id: string }>(
          `insert into singers (venue_id, display_name, phone_e164, joined_at)
           values ($1, $2, $3, $4) returning id`,
          [venueId, input.displayName, input.phoneE164, input.now.toString()],
        )
      ).rows[0]!.id;
    }
  }
  await sendCode(c, venueId, id, input.phoneE164, input.locale, input.now);
}

/**
 * The code for a number: confirms it (or signs its confirmed singer in again) and issues the phone's
 * token. A new sign-in replaces the singer's last token, so one phone holds the queue page at a time.
 */
export async function verifySingerCode(
  c: Queryable,
  venueId: string,
  input: { phoneE164: string; code: string; now: Temporal.Instant },
): Promise<{ token: string; singerId: string } | { wrong: true; tries_left: number }> {
  const s = (
    await c.query<{ id: string; confirmed: boolean }>(
      `select id, phone_verified_at is not null as confirmed from singers
        where venue_id = $1 and phone_e164 = $2 and code_hash is not null
        order by (phone_verified_at is not null) desc, joined_at desc, id limit 1 for update`,
      [venueId, input.phoneE164],
    )
  ).rows[0];
  if (!s)
    throw new ApiError("invalid_request", "ask for a new code", {
      details: { reason: "code_expired" },
    });
  const r = await verifySinger(c, venueId, {
    singerId: s.id,
    code: input.code,
    now: input.now,
    again: s.confirmed,
  });
  if ("wrong" in r) return r;
  const token = randomBytes(16).toString("base64url");
  await c.query("update singers set token_hash = $3 where venue_id = $1 and id = $2", [
    venueId,
    s.id,
    singerTokenHash(token),
  ]);
  return { token, singerId: s.id };
}

/** The singer a token belongs to, in this venue only. */
export async function singerByToken(
  c: Queryable,
  venueId: string,
  token: string,
): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const r = await c.query<{ id: string }>(
    "select id from singers where venue_id = $1 and token_hash = $2 and phone_verified_at is not null",
    [venueId, singerTokenHash(token)],
  );
  return r.rows[0]?.id ?? null;
}

export interface SingerSong {
  readonly id: string;
  readonly title: string;
  readonly artist: string | null;
  readonly status: "singing" | "queued";
  readonly round: number;
  readonly flag: "needs_drink_credit" | null;
}

export interface QueuePage {
  readonly venue_id: string;
  readonly venue_name: string;
  /** Bar mode is on: joining and queuing are open. */
  readonly open: boolean;
  readonly round: number;
  readonly song_price_cents: number | null;
  readonly singing: {
    readonly singer: string;
    readonly title: string;
    readonly artist: string | null;
  } | null;
  readonly up_next: readonly { readonly place: number; readonly singer: string }[];
  readonly count: number;
  readonly me: {
    readonly display_name: string;
    readonly credits: number;
    readonly has_tab: boolean;
    /** The singers still to start before the singer's next song; null with no song queued. */
    readonly singers_before: number | null;
    readonly singing_now: boolean;
    readonly songs: readonly SingerSong[];
  } | null;
}

/** The queue as the page shows it: who's singing, the next names, and the singer's own songs and place. */
export async function queuePage(
  c: Queryable,
  venueId: string,
  singerId: string | null,
  now: Temporal.Instant,
): Promise<QueuePage> {
  const q = await queueView(c, venueId, now);
  const venue = (
    await c.query<{ name: string }>("select name from venues where id = $1", [venueId])
  ).rows[0]!;
  let me: QueuePage["me"] = null;
  const self = singerId ? q.singers.find((s) => s.id === singerId) : undefined;
  if (self) {
    const mine = q.up_next.filter((s) => s.singer_id === self.id);
    const first = mine[0];
    const before = first
      ? new Set(
          q.up_next
            .filter((s) => s.place < first.place && s.singer_id !== self.id)
            .map((s) => s.singer_id),
        ).size
      : null;
    const singingNow = q.singing?.singer_id === self.id;
    me = {
      display_name: self.display_name,
      credits: self.credits,
      has_tab: self.has_tab,
      singers_before: before,
      singing_now: singingNow,
      songs: [
        ...(singingNow && q.singing ? [{ ...q.singing, status: "singing" as const }] : []),
        ...mine.map((s) => ({ ...s, status: "queued" as const })),
      ].map((s) => ({
        id: s.id,
        title: s.title,
        artist: s.artist,
        status: s.status,
        round: s.round,
        flag: s.status === "queued" ? s.flag : null,
      })),
    };
  }
  return {
    venue_id: venueId,
    venue_name: venue.name,
    open: (await barModeState(c, venueId)) === "on",
    round: q.round,
    song_price_cents: q.song_price_cents,
    singing: q.singing
      ? { singer: q.singing.singer, title: q.singing.title, artist: q.singing.artist }
      : null,
    up_next: q.up_next.slice(0, q.up_next_count).map((s) => ({ place: s.place, singer: s.singer })),
    count: q.count,
    me,
  };
}

/** A song the singer typed (or picked from the songbook once one is loaded, M6-23). */
export async function queueOwnSong(
  c: Queryable,
  venueId: string,
  input: { singerId: string; title: string; artist: string | null; now: Temporal.Instant },
) {
  return queueSong(c, venueId, {
    singerId: input.singerId,
    title: input.title,
    artist: input.artist,
    catalogId: null,
    userId: null,
    now: input.now,
  });
}

/**
 * The Up next TV (M6-22; Devices, printing and offline · Up next display): who's singing now, the
 * next `barMode.upNextCount` singers and what the join QR code opens. Display names and the song
 * only: never a phone number, a credit, a flag or a tab.
 */
export interface UpNextDisplay {
  readonly venue_id: string;
  readonly venue_name: string;
  /** The venue's slug: the QR code opens /v/{slug}/sing on the guest web. */
  readonly slug: string;
  readonly open: boolean;
  readonly singing: {
    readonly singer: string;
    readonly title: string;
    readonly artist: string | null;
  } | null;
  readonly up_next: readonly { readonly place: number; readonly singer: string }[];
}

export async function upNextDisplay(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
): Promise<UpNextDisplay> {
  const q = await queueView(c, venueId, now);
  const venue = (
    await c.query<{ name: string; slug: string }>("select name, slug from venues where id = $1", [
      venueId,
    ])
  ).rows[0]!;
  return {
    venue_id: venueId,
    venue_name: venue.name,
    slug: venue.slug,
    open: (await barModeState(c, venueId)) === "on",
    singing: q.singing
      ? { singer: q.singing.singer, title: q.singing.title, artist: q.singing.artist }
      : null,
    up_next: q.up_next.slice(0, q.up_next_count).map((s) => ({ place: s.place, singer: s.singer })),
  };
}
