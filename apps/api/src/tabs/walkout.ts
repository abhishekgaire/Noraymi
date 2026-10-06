import {
  allocate,
  amountDue,
  emitEvent,
  insertPayment,
  latestAttempt,
  readSetting,
  setAllocationState,
  setTip,
  startAttempt,
  withVenue,
  type AttemptRow,
  type PaymentRow,
  type Queryable,
} from "@west4/db";
import { businessDate, capCents, wallClock } from "@west4/rules";
import { cents, formatMoney, Temporal } from "@west4/shared";
import type pg from "pg";
import type { Sweep } from "@west4/db";
import { ApiError } from "../http/errors.js";
import { managerOnDutyAt } from "../approvals/service.js";
import { enqueuePush } from "../push/send-push.js";
import { venueClock } from "../rooms/assignment.js";
import { finalizeCheck } from "../rooms/finalize.js";
import { goAhead } from "../payments/card-on-file.js";
import { openAttempt } from "../payments/state.js";
import { enqueueRun, type PaymentDeps } from "../payments/run.js";
import { TAB_HOLD_COLS, holdCardOf, type TabHold } from "./hold.js";
import { moveTab } from "./state.js";
import { splitAtClose, settleHeldShare } from "./split.js";
import { tabSavedCard } from "./saved-card.js";
import { closingById, driveClose, type ClosingRow } from "./close.js";

/**
 * Walkouts and the tab cut-off (M6-16; Payment flows · Bar tab with a growing hold, step 6; Data model ·
 * Tabs at the cut-off and at close; API · `POST /nights/{date}/charge-remaining-tabs`):
 *  - Charge the remaining tabs (a manager, after one confirmation of how many cards and the total) closes
 *    every `open` tab not waiting on an approval, each at its balance with no tip;
 *  - the cut-off job, at `tabs.cutOffAt` on the wall clock of each business date (4:30 AM at West 4), does
 *    the same for every tab still `open`. A `tipping` tab is left until the reader answers (2 minutes at
 *    most), then treated as whatever it became; `awaiting_tip` tabs are the sweeper's (M6-17);
 *  - each walkout captures the balance up to the hold plus Stripe's overcapture allowance (no raise: the
 *    guest is gone); anything left goes on the card saved from the first tap, charged off-session, or the
 *    tab becomes `capture_failed`, never retried, and the manager on duty is alerted;
 *  - the tab ends `walkout_captured`, and its drinks with the times they went on stay with the Close as
 *    dispute evidence.
 * Every Stripe call runs in the payment run, outside any transaction, keyed by the payment and amount, so a
 * run killed midway and started again captures nothing twice.
 */
export type WalkoutBy = "charge_remaining" | "cut_off";
export const TAB_CUT_OFF_EVERY_MS = 15_000;

export interface WalkoutRow {
  walkout: WalkoutBy | null;
  rest_cents: number | null;
  rest_payment_id: string | null;
}

/** Inside the caller's transaction: the Close is written and its capture (or saved-card charge) queued. */
export async function startWalkout(
  c: Queryable,
  venueId: string,
  tabId: string,
  input: { by: WalkoutBy; userId: string | null; now: Temporal.Instant },
): Promise<{ closingId: string; paymentId: string } | null> {
  const r = await c.query<TabHold & { owner_id: string | null }>(
    `select ${TAB_HOLD_COLS}, t.owner_id
       from tabs t left join payments p on p.venue_id = t.venue_id and p.id = t.payment_id
      where t.venue_id = $1 and t.id = $2 for update of t`,
    [venueId, tabId],
  );
  const tab = r.rows[0];
  if (!tab) throw new ApiError("not_found", "no such tab");
  if (tab.state !== "open")
    throw new ApiError("invalid_request", `this tab is ${tab.state}`, {
      details: { reason: "tab_state", state: tab.state },
    });
  if (!tab.payment_id)
    throw new ApiError("invalid_request", "this tab has no card", {
      details: { reason: "no_card" },
    });
  const active = await c.query(
    `select 1 from tab_closings where venue_id = $1 and tab_id = $2
        and state in ('asking', 'custom', 'raising', 'capturing')`,
    [venueId, tabId],
  );
  if (active.rowCount)
    throw new ApiError("in_progress", "this tab is being closed", {
      details: { reason: "closing" },
    });
  const card = holdCardOf(tab);
  const holdId = card ? tab.payment_id : null;
  if (holdId) {
    const last = await latestAttempt(c, venueId, holdId);
    if (last && openAttempt(last.state))
      throw new ApiError("payment_unknown", "Checking with Stripe · don't retry", {
        details: { reason: "hold_checking", payment_id: holdId },
      });
  }
  const busy = await c.query(
    `select 1 from payment_allocations where venue_id = $1 and check_id = $2 and state = 'in_progress'
        and payment_id is distinct from $3`,
    [venueId, tab.check_id, holdId],
  );
  if (busy.rowCount)
    throw new ApiError("in_progress", "a payment is already under way on this tab", {
      details: { reason: "payment_in_progress" },
    });
  // The job has no person: the check is finalized in the name of the tab's owner, or the manager on duty.
  const by = input.userId ?? tab.owner_id ?? (await managerOnDutyAt(c, venueId, input.now));
  if (!by)
    throw new ApiError("invalid_request", "nobody to close this tab for", {
      details: { reason: "no_one" },
    });
  // A charge with no tip ends an open split, keeping the paid shares (M6-10).
  await splitAtClose(c, venueId, tab.check_id, "none", { userId: by, now: input.now });
  await finalizeCheck(c, venueId, tab.check_id, { userId: by, now: input.now });
  await c.query(
    `update checks k set status = case when exists (
         select 1 from payment_allocations a where a.venue_id = k.venue_id and a.check_id = k.id
            and a.state = 'captured' and a.payment_id is distinct from $3) then 'partly_paid' else 'finalized' end
      where k.venue_id = $1 and k.id = $2`,
    [venueId, tab.check_id, holdId],
  );
  const balance = await amountDue(c, tab.check_id, holdId);
  if (balance <= 0)
    throw new ApiError("invalid_request", "nothing is due on this tab", {
      details: { reason: "nothing_due" },
    });
  // Up to the hold plus the overcapture allowance; the rest goes on the saved card.
  const capture = card ? Math.min(balance, capCents(card)) : 0;
  const rest = balance - capture;
  const evidence = (
    await c.query<{ description: string; qty: string; amount_cents: string; added_at: string }>(
      `select description, qty::text, amount_cents::text, to_json(added_at) #>> '{}' as added_at
         from check_lines where venue_id = $1 and check_id = $2
          and kind in ('item', 'comp', 'void', 'discount', 'transfer_in', 'transfer_out')
        order by added_at, id`,
      [venueId, tab.check_id],
    )
  ).rows.map((l) => ({
    description: l.description,
    qty: Number(l.qty),
    amount_cents: Number(l.amount_cents),
    added_at: l.added_at,
  }));
  const closingId = (
    await c.query<{ id: string }>(
      `insert into tab_closings (venue_id, tab_id, check_id, payment_id, path, state, step_no, step_started_at,
         balance_cents, drinks_cents, gratuity_cents, tip_choice, tip_cents, capture_cents, closed_by, created_at,
         walkout, rest_cents, evidence)
       values ($1, $2, $3, $4, 'none', 'capturing', 0, $5, $6, 0, 0, 'none', 0, $7, $8, $5, $9, $10, $11)
       returning id`,
      [
        venueId,
        tabId,
        tab.check_id,
        tab.payment_id,
        input.now.toString(),
        balance,
        capture,
        input.userId,
        input.by,
        rest,
        JSON.stringify({ lines: evidence }),
      ],
    )
  ).rows[0]!.id;
  if (capture > 0) {
    await setTip(c, holdId!, 0);
    await setAllocationState(c, venueId, holdId!, "in_progress", "released");
    await allocate(c, venueId, {
      paymentId: holdId!,
      checkId: tab.check_id,
      amountCents: capture,
      state: "in_progress",
    });
    const { attemptNo } = await startAttempt(c, venueId, {
      paymentId: holdId!,
      checkId: tab.check_id,
      portionKey: "tab",
      action: "capture",
      amountCents: capture,
      keySuffix: String(capture),
      startedAt: input.now.toString(),
    });
    await enqueueRun(c, venueId, holdId!, attemptNo, input.now);
  } else {
    const closing = (await closingById(c, venueId, closingId, true))!;
    await chargeRest(c, venueId, closing, input.now);
  }
  await emitEvent(c, { venueId, type: "tab.updated", entityId: tabId });
  return { closingId, paymentId: tab.payment_id };
}

/** What the hold couldn't cover goes on the saved card, off-session; with no saved card, the tab fails. */
async function chargeRest(
  c: Queryable,
  venueId: string,
  closing: ClosingRow,
  now: Temporal.Instant,
): Promise<void> {
  const rest = closing.rest_cents ?? 0;
  const saved = await tabSavedCard(c, venueId, closing.check_id);
  if (!saved) return failWalkout(c, venueId, closing, now, rest);
  const venue = await venueClock(c, venueId);
  const paymentId = await insertPayment(c, venueId, {
    method: "card_on_file",
    status: "pending",
    businessDate: businessDate(now, venue.timeZone, venue.dayCutover).businessDate.toString(),
  });
  await allocate(c, venueId, {
    paymentId,
    checkId: closing.check_id,
    amountCents: rest,
    state: "in_progress",
  });
  await c.query("update tab_closings set rest_payment_id = $3 where venue_id = $1 and id = $2", [
    venueId,
    closing.id,
    paymentId,
  ]);
  // The guest agreed to the tab being charged at the cut-off (the consent line): no go-ahead to wait for.
  await goAhead(c, venueId, { paymentId, checkId: closing.check_id, amountCents: rest }, now);
}

/** The walkout is paid: the tab is walkout_captured. */
async function finishWalkout(
  c: Queryable,
  venueId: string,
  closing: ClosingRow,
  now: Temporal.Instant,
): Promise<void> {
  await c.query(
    "update tab_closings set state = 'captured', settled_at = now() where venue_id = $1 and id = $2",
    [venueId, closing.id],
  );
  await settleHeldShare(c, venueId, closing.check_id, "paid");
  await moveTab(c, venueId, closing.tab_id, "walkout_captured");
  await c.query("update tabs set closed_at = $3, closed_by = $4 where venue_id = $1 and id = $2", [
    venueId,
    closing.tab_id,
    now.toString(),
    closing.closed_by,
  ]);
  await emitEvent(c, { venueId, type: "tab.updated", entityId: closing.tab_id });
}

/** Nothing covers the rest: the tab is capture_failed, never retried, and the manager on duty hears. */
async function failWalkout(
  c: Queryable,
  venueId: string,
  closing: ClosingRow,
  now: Temporal.Instant,
  /** What the tab still owes: its balance, or the rest the saved card didn't pay. */
  owedCents: number,
): Promise<void> {
  await c.query(
    "update tab_closings set state = 'failed', settled_at = now() where venue_id = $1 and id = $2",
    [venueId, closing.id],
  );
  await moveTab(c, venueId, closing.tab_id, "capture_failed");
  await emitEvent(c, { venueId, type: "tab.updated", entityId: closing.tab_id });
  await emitEvent(c, { venueId, type: "check.updated", entityId: closing.check_id });
  await alertCaptureFailed(c, venueId, closing.tab_id, now, closing.id, owedCents);
}

/** A tab that became capture_failed: a push to the manager on duty, with the tab and what it still owes. */
export async function alertCaptureFailed(
  c: Queryable,
  venueId: string,
  tabId: string,
  now: Temporal.Instant,
  closingId: string,
  owedCents: number,
): Promise<void> {
  const tab = (
    await c.query<{ name: string; check_id: string }>(
      "select name, check_id from tabs where venue_id = $1 and id = $2",
      [venueId, tabId],
    )
  ).rows[0];
  const manager = await managerOnDutyAt(c, venueId, now);
  if (!tab || !manager) return;
  await enqueuePush(c, {
    venueId,
    audience: { kind: "person", userId: manager },
    message: {
      key: "tabs.push.captureFailed",
      params: { name: tab.name, amount: formatMoney("en", cents(owedCents)) },
      url: "/close-the-night",
      tag: `tab-capture-failed-${tabId}`,
    },
    runAt: now,
    dedupeKey: `tab-capture-failed:${closingId}`,
  });
}

/**
 * Inside the payment state machine's transaction, for a walkout's Close: the hold's capture went through
 * (the rest goes on the saved card, or the tab is walkout_captured), or the saved card's charge is known.
 * Answers whether anything changed.
 */
export async function settleWalkout(
  c: Queryable,
  venueId: string,
  closing: ClosingRow,
  payment: PaymentRow,
  attempt: AttemptRow,
  now: Temporal.Instant,
): Promise<boolean> {
  if (closing.state !== "capturing") return false;
  if (payment.id === closing.payment_id && attempt.action === "capture") {
    if (payment.status === "captured") {
      if ((closing.rest_cents ?? 0) > 0 && !closing.rest_payment_id)
        await chargeRest(c, venueId, closing, now);
      else await finishWalkout(c, venueId, closing, now);
      return true;
    }
    if (attempt.state === "failed" || attempt.state === "canceled") {
      await setAllocationState(c, venueId, closing.payment_id, "in_progress", "released");
      await settleHeldShare(c, venueId, closing.check_id, "open");
      await failWalkout(c, venueId, closing, now, closing.balance_cents);
      return true;
    }
    return false;
  }
  if (payment.id === closing.rest_payment_id && attempt.action === "off_session") {
    if (payment.status === "captured") {
      await finishWalkout(c, venueId, closing, now);
      return true;
    }
    if (attempt.state === "failed" || attempt.state === "canceled") {
      // Never retried: what it would have paid is owed again at once, for a manager to settle (M6-17),
      // without waiting for the decline's follow-up to cancel the payment.
      await setAllocationState(c, venueId, payment.id, "in_progress", "released");
      await failWalkout(c, venueId, closing, now, closing.rest_cents ?? 0);
      return true;
    }
  }
  return false;
}

/** The walkout Close a saved-card charge belongs to, if it's one. */
export async function walkoutOfRestPayment(
  c: Queryable,
  venueId: string,
  paymentId: string,
): Promise<string | null> {
  const r = await c.query<{ id: string }>(
    `select id from tab_closings where venue_id = $1 and rest_payment_id = $2 and state = 'capturing'
      for update`,
    [venueId, paymentId],
  );
  return r.rows[0]?.id ?? null;
}

/** Runs a walkout's charges here and now (the worker runs the same jobs if this process can't). */
export async function driveWalkout(deps: PaymentDeps, venueId: string, closingId: string) {
  const read = () =>
    withVenue(deps.pool, { venueId, requestId: `tab-walkout:${closingId}` }, (c) =>
      closingById(c, venueId, closingId),
    );
  const before = await read();
  if (!before) return;
  await driveClose(deps, venueId, before.payment_id);
  const after = await read();
  if (after?.rest_payment_id) await driveClose(deps, venueId, after.rest_payment_id);
}

/** The open tabs Charge the remaining tabs would charge: not waiting on an approval, something due. */
export interface Chargeable {
  readonly id: string;
  readonly name: string;
  readonly rest_cents: number;
}

/** Charge the remaining tabs: each tab in its own transaction, so one that can't go never holds up the rest. */
export async function chargeTabs(
  deps: PaymentDeps,
  venueId: string,
  tabs: readonly Chargeable[],
  input: { by: WalkoutBy; userId: string | null },
): Promise<{ id: string; started: boolean; reason: string | null; closingId: string | null }[]> {
  const out: { id: string; started: boolean; reason: string | null; closingId: string | null }[] =
    [];
  for (const tab of tabs) {
    try {
      const started = await withVenue(
        deps.pool,
        { venueId, requestId: `tab-walkout:${tab.id}` },
        (c) =>
          startWalkout(c, venueId, tab.id, {
            by: input.by,
            userId: input.userId,
            now: deps.clock.now(),
          }),
      );
      out.push({ id: tab.id, started: true, reason: null, closingId: started?.closingId ?? null });
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      const reason = (e.details as { reason?: string } | undefined)?.reason ?? e.code;
      out.push({ id: tab.id, started: false, reason, closingId: null });
    }
  }
  return out;
}

/** The instant the tab cut-off falls on for a business date: `tabs.cutOffAt` on that date's wall clock. */
export async function cutOffDue(
  c: Queryable,
  venueId: string,
  date: Temporal.PlainDate,
): Promise<Temporal.Instant | null> {
  const venue = await venueClock(c, venueId);
  const at = (await readSetting(c, venueId, "tabs", date))?.value.cutOffAt;
  return at ? wallClock(date, at, venue.timeZone, venue.dayCutover) : null;
}

/**
 * The tab cut-off for one venue: for tonight's business date (and last night's, should the job have been
 * down when it fell due), once the cut-off has passed, every `open` tab of that night or before is charged
 * as a walkout. The night's run is finished once no tab is `tipping` and every open tab was started; a run
 * killed midway is picked up by the next tick, which skips the tabs whose Close is already under way.
 */
export async function runTabCutOff(
  deps: Pick<PaymentDeps, "pool" | "clock">,
  venueId: string,
  now: Temporal.Instant,
): Promise<number> {
  const inVenue = <T>(fn: (c: Queryable) => Promise<T>) =>
    withVenue(deps.pool, { venueId, requestId: "sweep:tab-cut-off" }, fn);
  const due = await inVenue(async (c) => {
    const venue = await venueClock(c, venueId);
    const today = businessDate(now, venue.timeZone, venue.dayCutover).businessDate;
    const nights: { date: string; tabs: string[]; tipping: number }[] = [];
    for (const date of [today.subtract({ days: 1 }), today]) {
      const at = await cutOffDue(c, venueId, date);
      if (!at || Temporal.Instant.compare(now, at) < 0) continue;
      await c.query(
        `insert into tab_cut_off_runs (venue_id, business_date, due_at, started_at) values ($1, $2, $3, $4)
         on conflict (venue_id, business_date) do nothing`,
        [venueId, date.toString(), at.toString(), now.toString()],
      );
      const run = await c.query<{ finished: boolean }>(
        `select finished_at is not null as finished from tab_cut_off_runs
          where venue_id = $1 and business_date = $2 for update`,
        [venueId, date.toString()],
      );
      if (run.rows[0]!.finished) continue;
      // A tab whose walkout is already under way (a run killed midway) is never started again.
      const tabs = await c.query<{ id: string; state: string; closing: boolean }>(
        `select t.id, t.state, exists (select 1 from tab_closings x where x.venue_id = t.venue_id
                  and x.tab_id = t.id and x.state in ('asking', 'custom', 'raising', 'capturing')) as closing
           from tabs t join checks k on k.venue_id = t.venue_id and k.id = t.check_id
          where t.venue_id = $1 and k.business_date <= $2 and t.state in ('open', 'tipping')
          order by t.opened_at, t.id`,
        [venueId, date.toString()],
      );
      nights.push({
        date: date.toString(),
        tabs: tabs.rows.filter((t) => t.state === "open" && !t.closing).map((t) => t.id),
        tipping: tabs.rows.filter((t) => t.state === "tipping").length,
      });
    }
    return nights;
  });
  let started = 0;
  for (const night of due) {
    let unsettled = night.tipping > 0;
    for (const tabId of night.tabs) {
      try {
        await inVenue((c) => startWalkout(c, venueId, tabId, { by: "cut_off", userId: null, now }));
        started++;
        await inVenue((c) =>
          c.query(
            `update tab_cut_off_runs set tabs_charged = tabs_charged + 1
              where venue_id = $1 and business_date = $2`,
            [venueId, night.date],
          ),
        );
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        const reason = (e.details as { reason?: string } | undefined)?.reason;
        // A raise or a payment still being settled: the next tick tries again. Nothing due: nothing to do.
        if (reason !== "nothing_due" && reason !== "tab_state") unsettled = true;
      }
    }
    if (!unsettled)
      await inVenue((c) =>
        c.query(
          `update tab_cut_off_runs set finished_at = $3
            where venue_id = $1 and business_date = $2 and finished_at is null`,
          [venueId, night.date, now.toString()],
        ),
      );
  }
  return started;
}

export async function sweepTabCutOff(pool: pg.Pool, now: Temporal.Instant): Promise<number> {
  const venues = await pool.query<{ id: string }>("select id from venues_for_scheduler()");
  let started = 0;
  const clock = { now: () => now };
  for (const v of venues.rows) started += await runTabCutOff({ pool, clock }, v.id, now);
  return started;
}

export function tabCutOffSweep(pool: pg.Pool): Sweep {
  return {
    name: "tabs.cut-off",
    everyMs: TAB_CUT_OFF_EVERY_MS,
    run: async (now) => void (await sweepTabCutOff(pool, now)),
  };
}
