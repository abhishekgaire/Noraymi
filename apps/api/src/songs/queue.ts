import { createHash, randomInt } from "node:crypto";
import {
  addToStaffBank,
  drawerOfDevice,
  emitEvent,
  insertDrawerMove,
  insertPayment,
  insertPrintJob,
  readSetting,
  staffBank,
  venueModules,
  type Queryable,
} from "@west4/db";
import {
  businessDate,
  changeDue,
  drinkCreditUnits,
  moveSwap,
  placeNewSong,
  songFlag,
  upNext,
  type QueuedSong,
  type SongStatus,
} from "@west4/rules";
import type { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { venueClock } from "../rooms/assignment.js";
import { enqueueText } from "../jobs/send-text.js";
import { issuePrepaid } from "../payments/prepaid.js";

/**
 * Bar mode's song queue (M6-18; Song systems and texts · Bar mode: Joining,
 * Rotation and Credits). Singers join at the bar with a display name and a
 * number confirmed once by a code; songs rotate round-robin by singer, with
 * `barMode.songsPerRound` songs per singer per round; a staff move up or down
 * takes a reason and is logged. "Buy a drink, get a song": each drink unit on a
 * singer's tab earns a credit by itself, a drink bought at the bar earns one
 * when the bartender picks the singer, and queuing a song holds a credit. With
 * no song price (West 4) a song without a credit is flagged "Needs a drink
 * credit". A cut-off from alcohol never touches any of it. Every change emits
 * `song_queue.updated`; nothing here returns a singer's phone number.
 */
export const SINGER_CODE_MINUTES = 10;
export const SINGER_CODE_MAX_TRIES = 5;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const codeHash = (singerId: string, code: string) => sha256(`${singerId}:${code}`);

export async function nightOf(c: Queryable, venueId: string, now: Temporal.Instant) {
  const v = await venueClock(c, venueId);
  return businessDate(now, v.timeZone, v.dayCutover).businessDate;
}

export async function barMode(c: Queryable, venueId: string, date: Temporal.PlainDate) {
  const s = await readSetting(c, venueId, "barMode", date);
  return {
    songPriceCents: s?.value.songPriceCents ?? null,
    drinkCredit: s?.value.drinkCredit ?? false,
    songsPerRound: s?.value.songsPerRound ?? 1,
  };
}

async function barModeOn(c: Queryable, venueId: string): Promise<boolean> {
  const m = (await venueModules(c, venueId)).find((r) => r.module_id === "bar_mode");
  return !!m && m.state !== "off";
}

/** The night's row, made on the first change and locked: every change to the queue goes one at a time. */
export async function lockNight(
  c: Queryable,
  venueId: string,
  date: string,
  now: Temporal.Instant,
) {
  await c.query(
    `insert into song_nights (venue_id, business_date, started_at) values ($1, $2, $3)
     on conflict (venue_id, business_date) do nothing`,
    [venueId, date, now.toString()],
  );
  return (
    await c.query<{ id: string }>(
      "select id from song_nights where venue_id = $1 and business_date = $2 for update",
      [venueId, date],
    )
  ).rows[0]!.id;
}

export async function updated(c: Queryable, venueId: string, nightId: string) {
  await emitEvent(c, { venueId, type: "song_queue.updated", entityId: nightId });
}

async function nightIdOf(c: Queryable, venueId: string, now: Temporal.Instant) {
  const date = (await nightOf(c, venueId, now)).toString();
  return lockNight(c, venueId, date, now);
}

interface SongRow {
  id: string;
  singer_id: string;
  round: number;
  position: number;
  status: SongStatus;
  title: string;
  artist: string | null;
  pay_with: "credit" | "price";
  credit_id: string | null;
  started_at: string | null;
}

async function songsOf(c: Queryable, venueId: string, date: string): Promise<SongRow[]> {
  return (
    await c.query<SongRow>(
      `select id, singer_id, round, position, status, title, artist, pay_with, credit_id, started_at
         from song_queue where venue_id = $1 and business_date = $2 order by round, position`,
      [venueId, date],
    )
  ).rows;
}

const asQueued = (s: SongRow): QueuedSong => ({
  id: s.id,
  singerId: s.singer_id,
  round: s.round,
  position: s.position,
  status: s.status,
});

// ── The queue ───────────────────────────────────────────────────────────────────────────────────

export interface QueueView {
  readonly business_date: string;
  readonly round: number;
  readonly songs_sung: number;
  readonly song_price_cents: number | null;
  readonly songs_per_round: number;
  /** "Buy a drink, get a song": drinks earn credits. */
  readonly drink_credit: boolean;
  readonly singing: QueueSongView | null;
  readonly up_next: readonly QueueSongView[];
  readonly count: number;
  readonly singers: readonly SingerView[];
}

export interface QueueSongView {
  readonly id: string;
  readonly singer_id: string;
  readonly singer: string;
  readonly title: string;
  readonly artist: string | null;
  readonly round: number;
  readonly place: number;
  readonly pay_with: "credit" | "price";
  readonly holds_credit: boolean;
  readonly flag: "needs_drink_credit" | null;
  readonly credits: number;
  readonly started_at: string | null;
}

export interface SingerView {
  readonly id: string;
  readonly display_name: string;
  readonly confirmed: boolean;
  readonly has_tab: boolean;
  readonly credits: number;
}

async function singerViews(c: Queryable, venueId: string): Promise<SingerView[]> {
  return (
    await c.query<{
      id: string;
      display_name: string;
      confirmed: boolean;
      has_tab: boolean;
      credits: string;
    }>(
      `select s.id, s.display_name, s.phone_verified_at is not null as confirmed, s.check_id is not null as has_tab,
              (select count(*) from song_credits k where k.venue_id = s.venue_id and k.singer_id = s.id
                 and k.used_at is null and k.forfeited_at is null) as credits
         from singers s where s.venue_id = $1 order by s.display_name, s.id`,
      [venueId],
    )
  ).rows.map((r) => ({ ...r, credits: Number(r.credits) }));
}

export async function queueView(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
): Promise<QueueView> {
  const date = await nightOf(c, venueId, now);
  const settings = await barMode(c, venueId, date);
  const night = (
    await c.query<{ songs_sung: number }>(
      "select songs_sung from song_nights where venue_id = $1 and business_date = $2",
      [venueId, date.toString()],
    )
  ).rows[0];
  const songs = await songsOf(c, venueId, date.toString());
  const singers = await singerViews(c, venueId);
  const byId = new Map(singers.map((s) => [s.id, s]));
  const view = (s: SongRow, place: number): QueueSongView => {
    const sg = byId.get(s.singer_id)!;
    const holds = s.credit_id !== null;
    return {
      id: s.id,
      singer_id: s.singer_id,
      singer: sg.display_name,
      title: s.title,
      artist: s.artist,
      round: s.round,
      place,
      pay_with: s.pay_with,
      holds_credit: holds,
      flag:
        s.pay_with === "credit"
          ? songFlag({ holdsCredit: holds, songPriceCents: settings.songPriceCents })
          : null,
      credits: sg.credits,
      started_at: s.started_at,
    };
  };
  const singing = songs.find((s) => s.status === "singing");
  const queued = upNext(songs.map(asQueued)).map((q) => songs.find((s) => s.id === q.id)!);
  const rounds = songs.filter((s) => s.status !== "removed").map(asQueued);
  return {
    business_date: date.toString(),
    round: singing?.round ?? queued[0]?.round ?? Math.max(1, ...rounds.map((s) => s.round)),
    songs_sung: night?.songs_sung ?? 0,
    song_price_cents: settings.songPriceCents,
    songs_per_round: settings.songsPerRound,
    drink_credit: settings.drinkCredit,
    singing: singing ? view(singing, 0) : null,
    up_next: queued.map((s, i) => view(s, i + 1)),
    count: queued.length,
    singers,
  };
}

/** Puts a song in the rotation: the first round with room for the singer, at its end, holding a credit if one is free. */
export async function queueSong(
  c: Queryable,
  venueId: string,
  input: {
    singerId: string;
    title: string;
    artist: string | null;
    catalogId: string | null;
    userId: string | null;
    now: Temporal.Instant;
  },
): Promise<{ id: string; round: number; position: number; flag: "needs_drink_credit" | null }> {
  const date = await nightOf(c, venueId, input.now);
  const nightId = await lockNight(c, venueId, date.toString(), input.now);
  const singer = await lockSinger(c, venueId, input.singerId);
  if (!singer.confirmed)
    throw new ApiError("invalid_request", "the singer's number isn't confirmed yet", {
      details: { reason: "phone_not_confirmed" },
    });
  const settings = await barMode(c, venueId, date);
  const songs = await songsOf(c, venueId, date.toString());
  const place = placeNewSong(songs.map(asQueued), input.singerId, settings.songsPerRound);
  const credit = await freeCredit(c, venueId, input.singerId);
  // A song is paid with a credit when one is free or the venue sells no songs; otherwise at the price.
  const payWith = credit || settings.songPriceCents === null ? "credit" : "price";
  const r = await c.query<{ id: string }>(
    `insert into song_queue (venue_id, business_date, singer_id, check_id, title, artist, catalog_id, round, position,
       pay_with, price_cents, queued_by, queued_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
    [
      venueId,
      date.toString(),
      input.singerId,
      singer.check_id,
      input.title,
      input.artist,
      input.catalogId,
      place.round,
      place.position,
      payWith,
      payWith === "price" ? settings.songPriceCents : null,
      input.userId,
      input.now.toString(),
    ],
  );
  const id = r.rows[0]!.id;
  if (credit && payWith === "credit") await holdCredit(c, venueId, credit, id);
  await updated(c, venueId, nightId);
  return {
    id,
    ...place,
    flag:
      payWith === "credit"
        ? songFlag({ holdsCredit: !!credit, songPriceCents: settings.songPriceCents })
        : null,
  };
}

/** A staff move one place up or down, with who and why, on the song and in the move log. */
export async function moveSong(
  c: Queryable,
  venueId: string,
  input: {
    queueId: string;
    direction: "up" | "down";
    reason: string;
    userId: string;
    now: Temporal.Instant;
  },
): Promise<{ id: string; round: number; position: number }> {
  const date = await nightOf(c, venueId, input.now);
  const nightId = await lockNight(c, venueId, date.toString(), input.now);
  const songs = await songsOf(c, venueId, date.toString());
  const me = songs.find((s) => s.id === input.queueId);
  if (!me) throw new ApiError("not_found", "no such song in tonight's queue");
  if (me.status !== "queued")
    throw new ApiError("invalid_request", "only a song still waiting can move", {
      details: { reason: "not_queued" },
    });
  const swap = moveSwap(songs.map(asQueued), input.queueId, input.direction);
  if (!swap)
    throw new ApiError(
      "invalid_request",
      `it's already ${input.direction === "up" ? "first" : "last"}`,
      {
        details: { reason: "at_end" },
      },
    );
  const at = input.now.toString();
  for (const s of swap)
    await c.query(
      `update song_queue set round = $3, position = $4,
         moved_by = case when id = $5 then $6::uuid else moved_by end,
         moved_at = case when id = $5 then $7::timestamptz else moved_at end,
         move_reason = case when id = $5 then $8 else move_reason end
       where venue_id = $1 and id = $2`,
      [venueId, s.id, s.round, s.position, input.queueId, input.userId, at, input.reason],
    );
  const to = swap[0];
  await c.query(
    `insert into song_queue_moves (venue_id, queue_id, direction, reason, moved_by, moved_at, from_round,
       from_position, to_round, to_position)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      venueId,
      input.queueId,
      input.direction,
      input.reason,
      input.userId,
      at,
      me.round,
      me.position,
      to.round,
      to.position,
    ],
  );
  await updated(c, venueId, nightId);
  return { id: input.queueId, round: to.round, position: to.position };
}

/** The move log of one song: who moved it, which way, when and why. */
export async function songMoves(c: Queryable, venueId: string, queueId: string) {
  return (
    await c.query<{
      direction: "up" | "down";
      reason: string;
      moved_by: string;
      by_name: string;
      moved_at: string;
    }>(
      `select m.direction, m.reason, m.moved_by, u.name as by_name, m.moved_at
         from song_queue_moves m join users u on u.id = m.moved_by
        where m.venue_id = $1 and m.queue_id = $2 order by m.moved_at, m.id`,
      [venueId, queueId],
    )
  ).rows;
}

// ── Singers ─────────────────────────────────────────────────────────────────────────────────────

export async function lockSinger(c: Queryable, venueId: string, singerId: string) {
  const s = (
    await c.query<{ id: string; check_id: string | null; confirmed: boolean }>(
      `select id, check_id, phone_verified_at is not null as confirmed from singers
        where venue_id = $1 and id = $2 for update`,
      [venueId, singerId],
    )
  ).rows[0];
  if (!s) throw new ApiError("not_found", "no such singer");
  return s;
}

/** The open tab's check a singer's songs and drinks go on, refused for a closed tab or one another singer has. */
async function tabCheck(c: Queryable, venueId: string, tabId: string, singerId: string | null) {
  const t = (
    await c.query<{ check_id: string; state: string }>(
      "select check_id, state from tabs where venue_id = $1 and id = $2",
      [venueId, tabId],
    )
  ).rows[0];
  if (!t) throw new ApiError("not_found", "no such tab");
  if (t.state !== "open")
    throw new ApiError("invalid_request", "that tab isn't open", {
      details: { reason: "tab_not_open" },
    });
  const taken = await c.query(
    "select 1 from singers where venue_id = $1 and check_id = $2 and id is distinct from $3",
    [venueId, t.check_id, singerId],
  );
  if (taken.rowCount)
    throw new ApiError("invalid_request", "another singer has that tab", {
      details: { reason: "tab_taken" },
    });
  return t.check_id;
}

/**
 * + Singer at the bar: a display name and a number, confirmed once by a code texted to it. A number
 * already confirmed here is that singer, with no new code. A tab, when given, is where their songs and
 * drinks go, and the drinks already on it earn their credits.
 */
export async function addSinger(
  c: Queryable,
  venueId: string,
  input: {
    displayName: string;
    phoneE164: string;
    tabId: string | null;
    userId: string;
    locale: "en" | "es";
    now: Temporal.Instant;
  },
): Promise<{ id: string; confirmed: boolean; code_sent: boolean }> {
  const at = input.now.toString();
  const known = (
    await c.query<{ id: string }>(
      `select id from singers where venue_id = $1 and phone_e164 = $2 and phone_verified_at is not null for update`,
      [venueId, input.phoneE164],
    )
  ).rows[0];
  if (known) {
    if (input.tabId) await linkTab(c, venueId, known.id, input.tabId, input.now);
    return { id: known.id, confirmed: true, code_sent: false };
  }
  const checkId = input.tabId ? await tabCheck(c, venueId, input.tabId, null) : null;
  const r = await c.query<{ id: string }>(
    `insert into singers (venue_id, display_name, phone_e164, check_id, added_by, joined_at)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [venueId, input.displayName, input.phoneE164, checkId, input.userId, at],
  );
  const id = r.rows[0]!.id;
  await sendCode(c, venueId, id, input.phoneE164, input.locale, input.now);
  return { id, confirmed: false, code_sent: true };
}

export async function sendCode(
  c: Queryable,
  venueId: string,
  singerId: string,
  phoneE164: string,
  locale: "en" | "es",
  now: Temporal.Instant,
) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await c.query(
    `update singers set code_hash = $3, code_expires_at = $4, code_attempts = 0 where venue_id = $1 and id = $2`,
    [
      venueId,
      singerId,
      codeHash(singerId, code),
      now.add({ minutes: SINGER_CODE_MINUTES }).toString(),
    ],
  );
  const venueName =
    (await c.query<{ name: string }>("select name from venues where id = $1", [venueId])).rows[0]
      ?.name ?? "";
  await enqueueText(c, {
    venueId,
    runAt: now,
    template: "phone_code",
    to: phoneE164,
    locale,
    data: { venueName, code, minutes: SINGER_CODE_MINUTES },
  });
}

/**
 * The code texted to the singer's number: right once, then the number is confirmed for good. `again`
 * (the queue page, M6-20) checks a new code on a number already confirmed, to sign that singer in on
 * another phone.
 */
export async function verifySinger(
  c: Queryable,
  venueId: string,
  input: { singerId: string; code: string; now: Temporal.Instant; again?: boolean },
): Promise<{ confirmed: true } | { wrong: true; tries_left: number }> {
  const s = (
    await c.query<{
      phone_e164: string;
      code_hash: string | null;
      live: boolean;
      code_attempts: number;
      confirmed: boolean;
      check_id: string | null;
    }>(
      `select phone_e164, code_hash, coalesce(code_expires_at > $3::timestamptz, false) as live, code_attempts, phone_verified_at is not null as confirmed, check_id
         from singers where venue_id = $1 and id = $2 for update`,
      [venueId, input.singerId, input.now.toString()],
    )
  ).rows[0];
  if (!s) throw new ApiError("not_found", "no such singer");
  if (s.confirmed && !input.again) return { confirmed: true };
  const expired = !s.code_hash || !s.live;
  if (expired || s.code_attempts >= SINGER_CODE_MAX_TRIES)
    throw new ApiError("invalid_request", "ask for a new code", {
      details: { reason: "code_expired" },
    });
  if (codeHash(input.singerId, input.code) !== s.code_hash) {
    await c.query(
      "update singers set code_attempts = code_attempts + 1 where venue_id = $1 and id = $2",
      [venueId, input.singerId],
    );
    return { wrong: true, tries_left: SINGER_CODE_MAX_TRIES - s.code_attempts - 1 };
  }
  if (s.confirmed) {
    await c.query(
      "update singers set code_hash = null, code_expires_at = null where venue_id = $1 and id = $2",
      [venueId, input.singerId],
    );
    return { confirmed: true };
  }
  const taken = await c.query(
    "select 1 from singers where venue_id = $1 and phone_e164 = $2 and phone_verified_at is not null",
    [venueId, s.phone_e164],
  );
  if (taken.rowCount)
    throw new ApiError("invalid_request", "that number already belongs to a singer here", {
      details: { reason: "phone_taken" },
    });
  await c.query(
    `update singers set phone_verified_at = $3, code_hash = null, code_expires_at = null
      where venue_id = $1 and id = $2`,
    [venueId, input.singerId, input.now.toString()],
  );
  if (s.check_id) await syncCheckCredits(c, venueId, s.check_id, input.now);
  await updated(c, venueId, await nightIdOf(c, venueId, input.now));
  return { confirmed: true };
}

async function linkTab(
  c: Queryable,
  venueId: string,
  singerId: string,
  tabId: string,
  now: Temporal.Instant,
) {
  const s = await lockSinger(c, venueId, singerId);
  const checkId = await tabCheck(c, venueId, tabId, singerId);
  if (s.check_id === checkId) return;
  await c.query("update singers set check_id = $3 where venue_id = $1 and id = $2", [
    venueId,
    singerId,
    checkId,
  ]);
  await syncCheckCredits(c, venueId, checkId, now);
}

// ── Credits ─────────────────────────────────────────────────────────────────────────────────────

export async function freeCredit(c: Queryable, venueId: string, singerId: string) {
  return (
    (
      await c.query<{ id: string }>(
        `select id from song_credits where venue_id = $1 and singer_id = $2 and used_by_queue_id is null
           and used_at is null and forfeited_at is null order by earned_at, id limit 1 for update`,
        [venueId, singerId],
      )
    ).rows[0]?.id ?? null
  );
}

export async function holdCredit(c: Queryable, venueId: string, creditId: string, queueId: string) {
  await c.query("update song_credits set used_by_queue_id = $3 where venue_id = $1 and id = $2", [
    venueId,
    creditId,
    queueId,
  ]);
  await c.query("update song_queue set credit_id = $3 where venue_id = $1 and id = $2", [
    venueId,
    queueId,
    creditId,
  ]);
}

/**
 * A singer's free credits go to their queued songs still without one, first song first: a flagged
 * "Needs a drink credit" song can start once they've bought a drink.
 */
export async function holdFreeCredits(
  c: Queryable,
  venueId: string,
  singerId: string,
): Promise<number> {
  const waiting = await c.query<{ id: string }>(
    `select id from song_queue where venue_id = $1 and singer_id = $2 and status = 'queued' and pay_with = 'credit'
       and credit_id is null order by business_date, round, position`,
    [venueId, singerId],
  );
  let held = 0;
  for (const song of waiting.rows) {
    const credit = await freeCredit(c, venueId, singerId);
    if (!credit) break;
    await holdCredit(c, venueId, credit, song.id);
    held += 1;
  }
  return held;
}

/** A credit taken back (its drink was comped or voided): a free one first, else the one a queued song holds. */
async function forfeit(c: Queryable, venueId: string, lineId: number, n: number, at: string) {
  const open = await c.query<{ id: string; used_by_queue_id: string | null }>(
    `select id, used_by_queue_id from song_credits where venue_id = $1 and check_line_id = $2
       and used_at is null and forfeited_at is null
     order by (used_by_queue_id is not null), unit desc limit $3 for update`,
    [venueId, lineId, n],
  );
  for (const k of open.rows) {
    await c.query(
      "update song_credits set forfeited_at = $3, used_by_queue_id = null where venue_id = $1 and id = $2",
      [venueId, k.id, at],
    );
    if (k.used_by_queue_id)
      await c.query(
        "update song_queue set credit_id = null where venue_id = $1 and id = $2 and status = 'queued'",
        [venueId, k.used_by_queue_id],
      );
  }
  return open.rows.length;
}

async function creditLines(c: Queryable, venueId: string, checkId: string) {
  return (
    await c.query<{
      id: string;
      kind: string;
      qty: string;
      tax_category: string | null;
      reverses_id: string | null;
    }>(
      `select id, kind, qty, tax_category, reverses_id from check_lines
        where venue_id = $1 and check_id = $2 order by id`,
      [venueId, checkId],
    )
  ).rows.map((l) => ({
    id: Number(l.id),
    kind: l.kind,
    qty: Number(l.qty),
    taxCategory: l.tax_category,
    reversesId: l.reverses_id === null ? null : Number(l.reverses_id),
  }));
}

/**
 * "A drink rung on a singer's tab earns a credit by itself": brings a singer's tab check and their
 * credits into line. Each drink unit sold earns one; a unit comped or voided since forfeits one not yet
 * spent. Runs after every sale, comp and void on a check; a check no singer has, bar mode off, or the
 * drink credit off changes nothing. Returns how many credits were earned and forfeited.
 */
export async function syncCheckCredits(
  c: Queryable,
  venueId: string,
  checkId: string,
  now: Temporal.Instant,
): Promise<{ earned: number; forfeited: number }> {
  const singer = (
    await c.query<{ id: string }>(
      `select id from singers where venue_id = $1 and check_id = $2 and phone_verified_at is not null for update`,
      [venueId, checkId],
    )
  ).rows[0];
  if (!singer) return { earned: 0, forfeited: 0 };
  if (!(await barModeOn(c, venueId))) return { earned: 0, forfeited: 0 };
  const date = await nightOf(c, venueId, now);
  if (!(await barMode(c, venueId, date)).drinkCredit) return { earned: 0, forfeited: 0 };
  return applyUnits(c, venueId, singer.id, await creditLines(c, venueId, checkId), {
    givenBy: null,
    now,
  });
}

async function applyUnits(
  c: Queryable,
  venueId: string,
  singerId: string,
  lines: Awaited<ReturnType<typeof creditLines>>,
  who: { givenBy: string | null; now: Temporal.Instant },
): Promise<{ earned: number; forfeited: number }> {
  const units = drinkCreditUnits(lines);
  const at = who.now.toString();
  let earned = 0;
  let forfeited = 0;
  for (const [lineId, n] of units) {
    // Earn: each unit still sold that never had a credit (a forfeited unit keeps its row, so never earns again).
    for (let unit = 1; unit <= n; unit++) {
      const r = await c.query(
        `insert into song_credits (venue_id, singer_id, source, check_line_id, unit, given_by, earned_at)
         values ($1, $2, 'drink', $3, $4, $5, $6) on conflict (venue_id, check_line_id, unit) do nothing`,
        [venueId, singerId, lineId, unit, who.givenBy, at],
      );
      earned += r.rowCount ?? 0;
    }
    // Forfeit: more live credits than units still sold means a comp or void took some back.
    const live = (
      await c.query<{ n: string }>(
        "select count(*) as n from song_credits where venue_id = $1 and check_line_id = $2 and forfeited_at is null",
        [venueId, lineId],
      )
    ).rows[0]!.n;
    const over = Number(live) - n;
    if (over > 0) forfeited += await forfeit(c, venueId, lineId, over, at);
  }
  if (earned > 0 || forfeited > 0) await holdFreeCredits(c, venueId, singerId);
  if (earned > 0 || forfeited > 0) await updated(c, venueId, await nightIdOf(c, venueId, who.now));
  return { earned, forfeited };
}

async function drinkCreditOn(c: Queryable, venueId: string, now: Temporal.Instant) {
  const date = await nightOf(c, venueId, now);
  const settings = await barMode(c, venueId, date);
  if (!settings.drinkCredit)
    throw new ApiError("invalid_request", "drinks don't earn song credits here", {
      details: { reason: "drink_credit_off" },
    });
  return { date, settings };
}

/**
 * A drink bought at the bar without a tab earns a credit when the bartender picks the singer on the
 * sale (`POST /singers/{s}/credits` with the quick sale's check): one per drink unit on it, once the
 * sale is paid. The same sale picked again for the same singer changes nothing; another singer is refused.
 */
export async function giveSaleCredits(
  c: Queryable,
  venueId: string,
  input: { singerId: string; checkId: string; userId: string; now: Temporal.Instant },
): Promise<{ earned: number; credits: number }> {
  await drinkCreditOn(c, venueId, input.now);
  const singer = await lockSinger(c, venueId, input.singerId);
  if (!singer.confirmed)
    throw new ApiError("invalid_request", "the singer's number isn't confirmed yet", {
      details: { reason: "phone_not_confirmed" },
    });
  const check = (
    await c.query<{ kind: string; status: string }>(
      "select kind, status from checks where venue_id = $1 and id = $2 for update",
      [venueId, input.checkId],
    )
  ).rows[0];
  if (!check) throw new ApiError("not_found", "no such sale");
  if (check.kind !== "quick")
    throw new ApiError("invalid_request", "drinks on a tab earn their credits by themselves", {
      details: { reason: "not_a_quick_sale" },
    });
  if (check.status !== "paid")
    throw new ApiError("invalid_request", "the sale isn't paid yet", {
      details: { reason: "not_paid" },
    });
  const lines = await creditLines(c, venueId, input.checkId);
  const other = await c.query(
    `select 1 from song_credits where venue_id = $1 and check_line_id = any($2::bigint[]) and singer_id <> $3`,
    [venueId, lines.map((l) => l.id), input.singerId],
  );
  if (other.rowCount)
    throw new ApiError("invalid_request", "that sale's credits went to another singer", {
      details: { reason: "already_given" },
    });
  const { earned } = await applyUnits(c, venueId, input.singerId, lines, {
    givenBy: input.userId,
    now: input.now,
  });
  return { earned, credits: await openCredits(c, venueId, input.singerId) };
}

async function openCredits(c: Queryable, venueId: string, singerId: string) {
  return Number(
    (
      await c.query<{ n: string }>(
        `select count(*) as n from song_credits where venue_id = $1 and singer_id = $2
           and used_at is null and forfeited_at is null`,
        [venueId, singerId],
      )
    ).rows[0]!.n,
  );
}

/**
 * Song credit bought at the song price, paid in cash to staff: the cash goes into the bar drawer (or
 * the person's staff bank), the value onto the prepaid-value ledger as song credit for the singer, and
 * one credit each. Refused while the venue sets no song price (West 4).
 */
export async function buyPrepaidCredits(
  c: Queryable,
  venueId: string,
  input: {
    singerId: string;
    count: number;
    tenderedCents: number;
    userId: string;
    deviceId: string | null;
    now: Temporal.Instant;
  },
): Promise<{ payment_id: string; amount_cents: number; change_cents: number; credits: number }> {
  const date = await nightOf(c, venueId, input.now);
  const price = (await barMode(c, venueId, date)).songPriceCents;
  if (price === null)
    throw new ApiError("invalid_request", "no song price is set: songs need a drink credit", {
      details: { reason: "song_price_not_set" },
    });
  const singer = await lockSinger(c, venueId, input.singerId);
  if (!singer.confirmed)
    throw new ApiError("invalid_request", "the singer's number isn't confirmed yet", {
      details: { reason: "phone_not_confirmed" },
    });
  const amount = price * input.count;
  const change = changeDue({ owedCents: amount, tenderedCents: input.tenderedCents });
  if (change === null)
    throw new ApiError("invalid_request", "that's less than what's owed", {
      details: { reason: "short" },
    });
  const at = input.now.toString();
  const night = date.toString();
  const drawer = input.deviceId ? await drawerOfDevice(c, venueId, input.deviceId) : null;
  const inDrawer = drawer?.session_id ? drawer : null;
  const bankId = inDrawer ? null : await staffBank(c, venueId, input.userId, night);
  const paymentId = await insertPayment(c, venueId, {
    method: "cash",
    status: "captured",
    businessDate: night,
    amountCents: amount,
    tenderedCents: input.tenderedCents,
    changeCents: change,
    drawerSessionId: inDrawer?.session_id ?? null,
    staffBankId: bankId,
  });
  await insertDrawerMove(c, venueId, {
    drawerSessionId: inDrawer?.session_id ?? null,
    staffBankId: bankId,
    kind: "sale",
    amountCents: amount,
    paymentId,
    takenBy: input.userId,
    deviceId: input.deviceId,
    at,
  });
  if (inDrawer?.printer_device_id)
    await insertPrintJob(c, venueId, {
      kind: "drawer",
      station: inDrawer.station ?? "bar",
      deviceId: inDrawer.printer_device_id,
      payload: { reason: "cash", payment_id: paymentId, drawer_id: inDrawer.id },
      createdAt: at,
    });
  if (bankId) await addToStaffBank(c, venueId, bankId, amount);
  const accountId = await issuePrepaid(c, venueId, {
    kind: "song_credit",
    amountCents: amount,
    paymentId,
    singerId: input.singerId,
    by: input.userId,
    at,
    businessDate: night,
  });
  for (let i = 0; i < input.count; i++)
    await c.query(
      `insert into song_credits (venue_id, singer_id, source, payment_id, prepaid_account_id, given_by, earned_at)
       values ($1, $2, 'prepaid', $3, $4, $5, $6)`,
      [venueId, input.singerId, paymentId, accountId, input.userId, at],
    );
  await holdFreeCredits(c, venueId, input.singerId);
  await emitEvent(c, { venueId, type: "payment.updated", entityId: paymentId });
  await updated(c, venueId, await nightIdOf(c, venueId, input.now));
  return {
    payment_id: paymentId,
    amount_cents: amount,
    change_cents: change,
    credits: await openCredits(c, venueId, input.singerId),
  };
}
