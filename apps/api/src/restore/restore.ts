import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  applyVenueRestore,
  asRestore,
  asRetention,
  enqueue,
  reapplyErasures,
  restorePreflight,
  startRestoreRecord,
  stripeAccountFor,
  updateRestoreRecord,
  withVenue,
  type JobHandler,
  type RestoreCounts,
} from "@west4/db";
import { businessDate } from "@west4/rules";
import type { Clock } from "@west4/shared";
import { ERASE_KIND } from "../jobs/erase.js";
import { RETENTION_KIND } from "../jobs/retention.js";
import type { StripeClient } from "../stripe/client.js";
import type { StripeIntent } from "../stripe/payments.js";
import { pullSince, venueIntents, type PullDeps, type Pulled } from "./pull.js";

/**
 * The per-venue restore (M8-20; spec 13 · Backups and restore; runbook
 * docs/runbooks/restore-drill.md):
 *
 *   1. preflight: same migrations on both sides, the scratch copy isn't
 *      production, every venue table walled, every trigger steps aside;
 *   2. the venue's rows from the scratch copy, put back as app_migrator
 *      (packages/db/src/restore.ts);
 *   3. the pull: Stripe and Twilio since the restore point (./pull.ts), now
 *      or as the `restore.pull` job;
 *   4. the erasure log applied again, the erase job for anything found again
 *      at Stripe or Twilio, and the nightly retention run once more;
 *   5. the count against Stripe for the window, and the time against the
 *      recovery target, on the venue's `restores` row.
 */
export const RESTORE_PULL_KIND = "restore.pull";

/** The recovery target a restore is held to: 2 hours (spec 01 · Targets, a lost region). */
export const RESTORE_RTO_S = 2 * 60 * 60;

export interface RestoreDeps {
  /** Production as the table owner, who may act as app_migrator. */
  readonly target: pg.Pool;
  /** Production as app_rw (the API's role): the pull, the erasures and the jobs. */
  readonly app: pg.Pool;
  /** The scratch copy as its table owner. */
  readonly scratch?: pg.Pool;
  readonly clock: Clock;
  readonly stripe?: StripeClient;
  readonly venueTexts?: PullDeps["venueTexts"];
  readonly log?: (line: string) => void;
}

export interface RestoreInput {
  readonly venueId: string;
  readonly kind: "restore" | "drill";
  /** The instant the scratch copy was restored to (ISO). */
  readonly restorePoint: string;
  /** The scratch copy's name, for the record (never its credentials). */
  readonly scratchName: string;
  /** How long the cloud took to make the scratch copy, timed by whoever ran it (the drill). */
  readonly scratchReadyS?: number;
  readonly rtoTargetS?: number;
  /** "now": the pull runs here; "job": it's queued for the worker. */
  readonly pull: "now" | "job";
  readonly afterTable?: (table: string, index: number, of: number) => Promise<void> | void;
}

export interface StripeCheck {
  readonly window: { readonly from: string; readonly to: string };
  readonly stripe: { readonly count: number; readonly cents: number };
  readonly ours: { readonly count: number; readonly cents: number };
  /** PaymentIntents with no payment of ours. */
  readonly missing_here: string[];
  /** Our payments whose PaymentIntent Stripe didn't list. */
  readonly missing_at_stripe: string[];
  readonly amount_differs: { pi: string; stripe: number; ours: number }[];
  readonly match: boolean;
  readonly skipped?: string;
}

export interface RestoreReport {
  readonly restoreId: string;
  readonly venueId: string;
  readonly kind: "restore" | "drill";
  readonly restorePoint: string;
  readonly counts: RestoreCounts;
  readonly pulled: Pulled | null;
  readonly erasures: { reapplied: number; reopened: number } | null;
  readonly stripeCheck: StripeCheck | null;
  readonly timings: {
    readonly scratchReadyS: number | null;
    readonly applyS: number;
    readonly pullS: number | null;
    readonly totalS: number | null;
  };
  readonly target: { readonly rtoS: number; readonly withinTarget: boolean | null };
}

export class RestoreRefused extends Error {
  constructor(readonly problems: string[]) {
    super(`the restore was refused: ${problems.join("; ")}`);
  }
}

const seconds = (fromMs: number, toMs: number) => Math.round((toMs - fromMs) / 100) / 10;

/** Steps 1 and 2, then 3 to 5 now or through the job. */
export async function restoreVenue(deps: RestoreDeps, input: RestoreInput): Promise<RestoreReport> {
  if (!deps.scratch) throw new Error("no scratch copy to restore from");
  const problems = await restorePreflight(deps.target, deps.scratch, input.venueId);
  if (problems.length) throw new RestoreRefused(problems);
  const restoreId = randomUUID();
  const ctx = { venueId: input.venueId, restoreId };
  const rtoS = input.rtoTargetS ?? RESTORE_RTO_S;
  const started = Date.now();
  await startRestoreRecord(deps.target, {
    ...ctx,
    kind: input.kind,
    restorePoint: input.restorePoint,
    scratch: input.scratchName,
    startedAt: new Date(started).toISOString(),
    rtoTargetS: rtoS,
  });
  if (input.scratchReadyS !== undefined)
    await asRestore(deps.target, ctx, (c) =>
      c.query("update restores set scratch_ready_s = $3 where venue_id = $1 and id = $2", [
        ctx.venueId,
        restoreId,
        Math.round(input.scratchReadyS!),
      ]),
    );
  const v = (
    await deps.target.query<{ time_zone: string; day_cutover: string }>(
      "select time_zone, to_char(day_cutover, 'HH24:MI') as day_cutover from venues where id = $1",
      [input.venueId],
    )
  ).rows[0]!;
  const date = businessDate(deps.clock.now(), v.time_zone, v.day_cutover).businessDate.toString();
  let counts: RestoreCounts;
  try {
    counts = await applyVenueRestore({
      target: deps.target,
      scratch: deps.scratch,
      venueId: input.venueId,
      restoreId,
      businessDate: date,
      ...(input.afterTable ? { afterTable: input.afterTable } : {}),
    });
  } catch (e) {
    await updateRestoreRecord(deps.target, ctx, {
      state: "failed",
      failure: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
  const applied = Date.now();
  deps.log?.(`restore ${restoreId}: rows put back in ${seconds(started, applied)} s`);
  await updateRestoreRecord(deps.target, ctx, {
    state: "pulling",
    applied_at: new Date(applied).toISOString(),
    inserted: counts.inserted,
    updated: counts.updated,
    settings_versions: counts.settingsVersions,
    skipped: counts.skipped,
  });
  const base = {
    restoreId,
    venueId: input.venueId,
    kind: input.kind,
    restorePoint: input.restorePoint,
    counts,
  };
  if (input.pull === "job") {
    await withVenue(deps.app, { venueId: input.venueId, requestId: `restore:${restoreId}` }, (c) =>
      enqueue(c, {
        venueId: input.venueId,
        kind: RESTORE_PULL_KIND,
        pool: "normal",
        dedupeKey: `${RESTORE_PULL_KIND}:${restoreId}`,
        payload: { restore_id: restoreId },
        runAt: deps.clock.now(),
        maxAttempts: 10,
      }),
    );
    return {
      ...base,
      pulled: null,
      erasures: null,
      stripeCheck: null,
      timings: {
        scratchReadyS: input.scratchReadyS ?? null,
        applyS: seconds(started, applied),
        pullS: null,
        totalS: null,
      },
      target: { rtoS, withinTarget: null },
    };
  }
  const finished = await finishRestore(deps, input.venueId, restoreId, { inline: true });
  return {
    ...base,
    ...finished,
    timings: { ...finished.timings, applyS: seconds(started, applied) },
  };
}

export type FinishDeps = Pick<RestoreDeps, "app" | "clock" | "stripe" | "venueTexts" | "log">;

/** Steps 3 to 5 for a restore whose rows are back (the job, or restoreVenue itself), as app_rw. */
export async function finishRestore(
  deps: FinishDeps,
  venueId: string,
  restoreId: string,
  options: { inline?: boolean } = {},
): Promise<
  Pick<RestoreReport, "pulled" | "erasures" | "stripeCheck" | "target"> & {
    timings: Omit<RestoreReport["timings"], "applyS">;
  }
> {
  const inVenue = <T>(work: (c: pg.PoolClient) => Promise<T>) =>
    withVenue(deps.app, { venueId, requestId: `restore:${restoreId}` }, (c) =>
      work(c as pg.PoolClient),
    );
  const row = await inVenue((c) =>
    c.query<{
      restore_point: Date;
      started_at: Date;
      scratch_ready_s: number | null;
      rto_target_s: number | null;
      state: string;
    }>(
      "select restore_point, started_at, scratch_ready_s, rto_target_s, state from restores where venue_id = $1 and id = $2",
      [venueId, restoreId],
    ),
  );
  const r = row.rows[0];
  if (!r) throw new Error(`no restore ${restoreId} for this venue`);
  const since = r.restore_point.toISOString();
  const pullStart = Date.now();
  const pulled = await pullSince(
    {
      pool: deps.app,
      clock: deps.clock,
      ...(deps.stripe ? { stripe: deps.stripe } : {}),
      ...(deps.venueTexts ? { venueTexts: deps.venueTexts } : {}),
      inline: options.inline ?? false,
    },
    venueId,
    restoreId,
    since,
  );
  // The erasure log, applied again after the pull (a reply pulled from Twilio can't bring a number back).
  const again = await inVenue(async (c) => {
    await asRetention(c);
    return reapplyErasures(c, venueId);
  });
  const now = deps.clock.now();
  await inVenue(async (c) => {
    for (const id of again.reopened)
      await enqueue(c, {
        venueId,
        kind: ERASE_KIND,
        pool: "normal",
        runAt: now,
        payload: { erasure_id: id },
        dedupeKey: `erase:${id}:restore:${restoreId}`,
      });
    // The nightly retention once more, so rows the copy brought back past their time go again.
    await enqueue(c, {
      venueId,
      kind: RETENTION_KIND,
      pool: "bulk",
      runAt: now,
      dedupeKey: `${RETENTION_KIND}:restore:${restoreId}`,
    });
  });
  const done = Date.now();
  const stripeCheck = deps.stripe
    ? await checkAgainstStripe(deps.app, deps.stripe, venueId, since, new Date(done).toISOString())
    : null;
  const totalS = seconds(r.started_at.getTime(), done) + (r.scratch_ready_s ?? 0);
  const rtoS = r.rto_target_s ?? RESTORE_RTO_S;
  const withinTarget = totalS <= rtoS;
  await inVenue((c) =>
    c.query(
      `update restores set state = 'done', finished_at = $3, pulled = $4, erasures_reapplied = $5,
              stripe_check = $6, within_target = $7
        where venue_id = $1 and id = $2`,
      [
        venueId,
        restoreId,
        new Date(done).toISOString(),
        JSON.stringify(pulled),
        again.erasures,
        stripeCheck ? JSON.stringify(stripeCheck) : null,
        withinTarget,
      ],
    ),
  );
  return {
    pulled,
    erasures: { reapplied: again.erasures, reopened: again.reopened.length },
    stripeCheck,
    timings: {
      scratchReadyS: r.scratch_ready_s,
      pullS: seconds(pullStart, done),
      totalS,
    },
    target: { rtoS, withinTarget },
  };
}

/** What a live payment counts for: its PaymentIntent's amount, as Stripe holds or received it. */
const COUNTED = ["authorized", "captured", "partly_refunded", "refunded"];

/**
 * The restored venue's card payments against Stripe's PaymentIntents for the
 * window: every PaymentIntent created in it that succeeded or holds money,
 * and every live payment of ours made in it or naming one of those.
 */
export async function checkAgainstStripe(
  app: pg.Pool,
  stripe: StripeClient,
  venueId: string,
  from: string,
  to: string,
): Promise<StripeCheck> {
  const window = { from, to };
  const empty = { count: 0, cents: 0 };
  const account = await withVenue(app, { venueId, requestId: "restore:check" }, (c) =>
    stripeAccountFor(c, venueId, false),
  );
  if (!account)
    return {
      window,
      stripe: empty,
      ours: empty,
      missing_here: [],
      missing_at_stripe: [],
      amount_differs: [],
      match: true,
      skipped: "the venue has no Stripe account",
    };
  const intents = (await venueIntents(app, stripe, venueId, account, from, to)).filter(
    (pi) => pi.status === "succeeded" || pi.status === "requires_capture",
  );
  const stripeCents = (pi: StripeIntent) =>
    pi.status === "succeeded"
      ? (pi.amount_received ?? pi.amount)
      : (pi.amount_capturable ?? pi.amount);
  const ours = await withVenue(app, { venueId, requestId: "restore:check" }, (c) =>
    c.query<{ id: string; pi: string; cents: string }>(
      `select id, stripe_pi_id as pi,
              case when status = 'authorized'
                   then coalesce(authorized_cents, amount_cents + tip_cents + surcharge_cents)
                   else amount_cents + tip_cents + surcharge_cents end as cents
         from payments
        where venue_id = $1 and not training and stripe_pi_id is not null and status = any($2::text[])
          and (stripe_pi_id = any($3::text[]) or (created_at >= $4 and created_at <= $5))`,
      [venueId, COUNTED, intents.map((pi) => pi.id), from, to],
    ),
  );
  const byPi = new Map(ours.rows.map((p) => [p.pi, p]));
  const atStripe = new Map(intents.map((pi) => [pi.id, pi]));
  const amountDiffers: StripeCheck["amount_differs"] = [];
  for (const pi of intents) {
    const p = byPi.get(pi.id);
    if (p && Number(p.cents) !== stripeCents(pi))
      amountDiffers.push({ pi: pi.id, stripe: stripeCents(pi), ours: Number(p.cents) });
  }
  const stripeSide = {
    count: intents.length,
    cents: intents.reduce((s, pi) => s + stripeCents(pi), 0),
  };
  const ourSide = {
    count: ours.rows.length,
    cents: ours.rows.reduce((s, p) => s + Number(p.cents), 0),
  };
  const missingHere = intents.filter((pi) => !byPi.has(pi.id)).map((pi) => pi.id);
  const missingAtStripe = ours.rows.filter((p) => !atStripe.has(p.pi)).map((p) => p.id);
  return {
    window,
    stripe: stripeSide,
    ours: ourSide,
    missing_here: missingHere,
    missing_at_stripe: missingAtStripe,
    amount_differs: amountDiffers,
    match:
      stripeSide.count === ourSide.count &&
      stripeSide.cents === ourSide.cents &&
      missingHere.length === 0 &&
      missingAtStripe.length === 0 &&
      amountDiffers.length === 0,
  };
}

/** The `restore.pull` job: steps 3 to 5 for the restore in its payload. */
export function makeRestorePullHandler(deps: FinishDeps): JobHandler {
  return async ({ job }) => {
    const restoreId = String((job.payload as { restore_id?: unknown } | null)?.restore_id ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(restoreId)) return;
    // Only a restore of the job's own venue still pulling: anything else finds nothing.
    const pulling = await withVenue(
      deps.app,
      { venueId: job.venue_id, requestId: `restore:${restoreId}` },
      (c) =>
        c.query("select 1 from restores where venue_id = $1 and id = $2 and state = 'pulling'", [
          job.venue_id,
          restoreId,
        ]),
    );
    if (pulling.rowCount === 0) return;
    await finishRestore(deps, job.venue_id, restoreId);
  };
}
