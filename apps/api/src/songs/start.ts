import { addCheckLine, emitEvent, type Queryable } from "@west4/db";
import { prepaidCreditValue, songCharge } from "@west4/rules";
import type { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { planSingerAlerts } from "./alerts.js";
import { redeemPrepaid, spendPrepaid } from "../payments/prepaid.js";
import { flagIfOver, holdCardOf, tabOfCheck, withinHold, type TabHold } from "../tabs/hold.js";
import {
  barMode,
  freeCredit,
  holdCredit,
  holdFreeCredits,
  lockNight,
  lockSinger,
  nightOf,
  updated,
} from "./queue.js";

/**
 * Started and Skip (M6-19; Payment flows · Songs on a tab; Money rules 6 and 8; Song systems and texts ·
 * Started and Skip, the play log). A song is charged when it starts, never when it's queued:
 *  - Started marks the song singing (the one before it sung), and posts its line to the singer's open tab:
 *    $0.00 on a drink credit (the credit is spent); at the credit's value on a prepaid song credit, paid by
 *    redeeming that value onto the tab; or at the venue's song price with no credit, which grows the hold
 *    as a round does (withinHold). A singer with no tab spends a credit and no line posts; with no credit
 *    they need one, or a tab where a song price is set. Every start writes the play log (`song_plays`).
 *  - Skip is free: a credit held for the song comes back, and goes to the singer's next song without one.
 * Song lines carry tax category `song`; whether it's taxed is the rule pack's (Money rules 8).
 * A cut-off from alcohol never stops a song.
 */

export type StartAnswer =
  | {
      readonly kind: "started";
      readonly song: {
        readonly id: string;
        readonly title: string;
        readonly artist: string | null;
        readonly singer_id: string;
        readonly paid_with: "drink_credit" | "prepaid_credit" | "price";
        readonly line_id: number | null;
        readonly amount_cents: number;
        readonly check_id: string | null;
        readonly started_at: string;
      };
    }
  | { readonly kind: "raise"; readonly paymentId: string; readonly attemptNo: number }
  | { readonly kind: "checking"; readonly paymentId: string };

interface QueueRow {
  id: string;
  singer_id: string;
  business_date: string;
  title: string;
  artist: string | null;
  status: string;
  credit_id: string | null;
}

async function lockSong(c: Queryable, venueId: string, queueId: string): Promise<QueueRow> {
  const s = (
    await c.query<QueueRow>(
      `select id, singer_id, business_date::text, title, artist, status, credit_id
         from song_queue where venue_id = $1 and id = $2 for update`,
      [venueId, queueId],
    )
  ).rows[0];
  if (!s) throw new ApiError("not_found", "no such song");
  if (s.status !== "queued")
    throw new ApiError("invalid_request", "that song isn't waiting in the queue", {
      details: { reason: "song_not_queued", status: s.status },
    });
  return s;
}

/** The song's line text: "Mr. Brightside · The Killers". */
const songLine = (s: { title: string; artist: string | null }) =>
  s.artist ? `${s.title} · ${s.artist}` : s.title;

/** A prepaid song credit's value: what its purchase paid for each credit it gave. */
async function prepaidValue(c: Queryable, venueId: string, accountId: string) {
  const r = await c.query<{ issued: string; n: string }>(
    `select (select coalesce(sum(amount_cents), 0) from prepaid_ledger
              where venue_id = $1 and account_id = $2 and kind = 'issued') as issued,
            (select count(*) from song_credits where venue_id = $1 and prepaid_account_id = $2) as n`,
    [venueId, accountId],
  );
  return prepaidCreditValue(Number(r.rows[0]!.issued), Number(r.rows[0]!.n));
}

export async function startSong(
  c: Queryable,
  venueId: string,
  input: {
    queueId: string;
    userId: string | null;
    source: "staff" | "adapter";
    now: Temporal.Instant;
    raised?: boolean;
  },
): Promise<StartAnswer> {
  const date = await nightOf(c, venueId, input.now);
  const nightId = await lockNight(c, venueId, date.toString(), input.now);
  const song = await lockSong(c, venueId, input.queueId);
  const singer = await lockSinger(c, venueId, song.singer_id);
  const settings = await barMode(c, venueId, date);
  const at = input.now.toString();
  const night = date.toString();

  // The singer's open tab, if they have one: a closed tab takes no more lines.
  let tab: TabHold | null = null;
  if (singer.check_id) {
    const t = await tabOfCheck(c, venueId, singer.check_id, true);
    if (t && t.state === "open") tab = t;
  }

  // The credit it uses: the one it holds, else one that's free now.
  // On a free night none is spent, and a credit the song held goes back to the singer.
  if (settings.freeNight && song.credit_id) {
    await c.query(
      "update song_credits set used_by_queue_id = null where venue_id = $1 and id = $2",
      [venueId, song.credit_id],
    );
    await c.query("update song_queue set credit_id = null where venue_id = $1 and id = $2", [
      venueId,
      song.id,
    ]);
  }
  const creditId = settings.freeNight
    ? null
    : (song.credit_id ?? (await freeCredit(c, venueId, song.singer_id)));
  const credit = creditId
    ? (
        await c.query<{
          id: string;
          source: "drink" | "prepaid";
          prepaid_account_id: string | null;
        }>(
          "select id, source, prepaid_account_id from song_credits where venue_id = $1 and id = $2 for update",
          [venueId, creditId],
        )
      ).rows[0]!
    : null;
  const charge = songCharge({
    credit: credit
      ? {
          source: credit.source,
          valueCents:
            credit.source === "prepaid"
              ? await prepaidValue(c, venueId, credit.prepaid_account_id!)
              : 0,
        }
      : null,
    songPriceCents: settings.songPriceCents,
    hasTab: tab !== null,
    freeNight: settings.freeNight,
  });
  if (charge.kind === "refused")
    throw new ApiError(
      "invalid_request",
      charge.reason === "needs_drink_credit"
        ? "Needs a drink credit"
        : "no tab and no credit: open a tab with a tap, or buy song credit",
      { details: { reason: charge.reason } },
    );
  const paidWith = charge.paidWith;
  const amount = charge.amountCents;

  // The money first, before anything else is written: a hold raise rolls back to here and comes again.
  let lineId: number | null = null;
  if (tab) {
    const checkId = tab.check_id;
    const write = async () => {
      const id = await addCheckLine(c, venueId, checkId, {
        kind: "song",
        description: songLine(song),
        qty: 1,
        unitCents: amount,
        amountCents: amount,
        taxCategory: "song",
        businessDate: night,
        addedBy: input.userId,
        addedAt: at,
      });
      if (paidWith === "prepaid_credit" && amount > 0)
        await redeemPrepaid(c, venueId, {
          accountId: credit!.prepaid_account_id!,
          checkId,
          amountCents: amount,
          by: input.userId,
          at,
          businessDate: night,
        });
      return id;
    };
    const card = amount > 0 ? holdCardOf(tab) : null;
    if (!card) lineId = await write();
    else {
      const step = await withinHold(c, venueId, tab, card, input, write);
      if (step.kind === "raise" || step.kind === "checking") return step;
      if (step.kind === "declined")
        throw new ApiError(
          "invalid_request",
          "Hold raise declined: the song can't go on this tab; take cash for song credit",
          { details: { reason: "hold_declined" } },
        );
      lineId = step.value;
    }
  } else if (paidWith === "prepaid_credit" && amount > 0) {
    await spendPrepaid(c, venueId, {
      accountId: credit!.prepaid_account_id!,
      amountCents: amount,
      by: input.userId,
      at,
      businessDate: night,
    });
  }

  // The credit is spent on this song.
  if (credit) {
    if (song.credit_id !== credit.id) await holdCredit(c, venueId, credit.id, song.id);
    await c.query("update song_credits set used_at = $3 where venue_id = $1 and id = $2", [
      venueId,
      credit.id,
      at,
    ]);
  }

  // The singer before is sung; this one is singing.
  const before = await c.query<{ id: string }>(
    `update song_queue set status = 'sung' where venue_id = $1 and business_date = $2 and status = 'singing'
     returning id`,
    [venueId, song.business_date],
  );
  if (before.rowCount)
    await c.query(
      "update song_nights set songs_sung = songs_sung + $3 where venue_id = $1 and business_date = $2",
      [venueId, song.business_date, before.rowCount],
    );
  await c.query(
    `update song_queue set status = 'singing', started_by = $3, started_at = $4, check_line_id = $5,
       check_id = coalesce($6, check_id), pay_with = $7, price_cents = $8
     where venue_id = $1 and id = $2`,
    [
      venueId,
      song.id,
      input.userId,
      at,
      lineId,
      tab?.check_id ?? null,
      paidWith === "price" ? "price" : "credit",
      paidWith === "price" ? amount : null,
    ],
  );
  await c.query("update singers set last_song_at = $3 where venue_id = $1 and id = $2", [
    venueId,
    song.singer_id,
    at,
  ]);

  // The play log.
  await c.query(
    `insert into song_plays (venue_id, business_date, queue_id, singer_id, check_id, title, artist, started_at,
       started_by, source)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      venueId,
      song.business_date,
      song.id,
      song.singer_id,
      tab?.check_id ?? null,
      song.title,
      song.artist,
      at,
      input.userId,
      input.source,
    ],
  );

  if (tab) {
    if (amount > 0) await flagIfOver(c, venueId, tab, input.now);
    await emitEvent(c, { venueId, type: "tab.updated", entityId: tab.tab_id });
    await emitEvent(c, {
      venueId,
      type: "check.updated",
      entityId: tab.check_id,
      entityVersion: 0,
    });
  }
  await planSingerAlerts(c, venueId, input.now);
  await updated(c, venueId, nightId);
  return {
    kind: "started",
    song: {
      id: song.id,
      title: song.title,
      artist: song.artist,
      singer_id: song.singer_id,
      paid_with: paidWith,
      line_id: lineId,
      amount_cents: amount,
      check_id: tab?.check_id ?? null,
      started_at: at,
    },
  };
}

/** Skip: free. The song leaves the queue, and a credit it held goes back to the singer's next song or stays free. */
export async function skipSong(
  c: Queryable,
  venueId: string,
  input: { queueId: string; userId: string | null; now: Temporal.Instant },
): Promise<{ id: string; status: "skipped"; credit_returned: boolean }> {
  const date = await nightOf(c, venueId, input.now);
  const nightId = await lockNight(c, venueId, date.toString(), input.now);
  const song = await lockSong(c, venueId, input.queueId);
  await lockSinger(c, venueId, song.singer_id);
  await c.query(
    `update song_queue set status = 'skipped', skipped_by = $3, skipped_at = $4, credit_id = null
     where venue_id = $1 and id = $2`,
    [venueId, song.id, input.userId, input.now.toString()],
  );
  if (song.credit_id) {
    await c.query(
      "update song_credits set used_by_queue_id = null where venue_id = $1 and id = $2 and used_at is null",
      [venueId, song.credit_id],
    );
    await holdFreeCredits(c, venueId, song.singer_id);
  }
  await planSingerAlerts(c, venueId, input.now);
  await updated(c, venueId, nightId);
  return { id: song.id, status: "skipped", credit_returned: song.credit_id !== null };
}
