import { GetObjectCommand } from "@aws-sdk/client-s3";
import { emitEvent, paymentByIntent, stripeAccountOf, withVenue, type Queryable } from "@west4/db";
import { Temporal, cents, formatMoney } from "@west4/shared";
import type pg from "pg";
import { ApiError } from "../http/errors.js";
import { htmlToPdf } from "../menu/pdf.js";
import { receiptModel, receiptText, receiptTime } from "../receipts/model.js";
import type { S3Settings } from "../s3.js";
import type { StripeClient } from "../stripe/client.js";
import { stripeEventHandlers } from "../stripe/webhooks.js";

/**
 * Disputes (M4-24; Stripe setup step 9; screens N37). When a guest's bank
 * disputes a payment, `charge.dispute.created` opens an item with its
 * evidence already gathered from our rows: the check's receipt, the room
 * clock's segments, the booking's accepted policy (from M5), damage photos and
 * who accepted and delivered each order. Submit, before the due date, turns
 * them into Stripe's evidence (the receipt as a PDF and a photo through the
 * Files API) and submits. Closing (won or lost) and each funds move are kept
 * for M7's journal.
 */
export interface Evidence {
  readonly receipt: { readonly check_id: string; readonly number: string } | null;
  readonly clock: readonly string[];
  readonly policy: {
    readonly version_id: string;
    readonly accepted_at: string | null;
    readonly ip: string | null;
    readonly ua: string | null;
  } | null;
  readonly damage_photos: readonly string[];
  readonly served: readonly string[];
  readonly note: string | null;
}

interface StripeDispute {
  readonly id: string;
  readonly amount: number;
  readonly reason: string;
  readonly status: string;
  readonly payment_intent: string | null;
  readonly evidence_details?: { due_by?: number | null };
}

const money = (c: number) => formatMoney("en", cents(c));

/** Gathers what our rows already prove about a payment's check, as the item opens. */
export async function gatherEvidence(
  c: Queryable,
  venueId: string,
  paymentId: string,
): Promise<{ checkId: string | null; evidence: Evidence; fileIds: string[] }> {
  const check = (
    await c.query<{
      id: string;
      number: string;
      room_session_id: string | null;
      booking_id: string | null;
      time_zone: string;
    }>(
      `select k.id, k.number::text, k.room_session_id, coalesce(k.booking_id, p.booking_id) as booking_id, v.time_zone
         from payment_allocations a
         join checks k on k.venue_id = a.venue_id and k.id = a.check_id
         join payments p on p.venue_id = a.venue_id and p.id = a.payment_id
         join venues v on v.id = k.venue_id
        where a.venue_id = $1 and a.payment_id = $2 and a.kind = 'payment'
        order by a.created_at limit 1`,
      [venueId, paymentId],
    )
  ).rows[0];
  const zone = check?.time_zone ?? "America/New_York";
  const clock: string[] = [];
  if (check?.room_session_id) {
    const segs = await c.query<{
      started_at: string;
      ended_at: string | null;
      billable_guests: number;
      hourly_cents: string;
      room: string;
    }>(
      `select to_json(g.started_at) #>> '{}' as started_at, to_json(g.ended_at) #>> '{}' as ended_at,
              g.billable_guests, g.hourly_cents, r.name as room
         from session_segments g join rooms r on r.venue_id = g.venue_id and r.id = g.room_id
        where g.venue_id = $1 and g.session_id = $2 order by g.started_at`,
      [venueId, check.room_session_id],
    );
    for (const s of segs.rows)
      clock.push(
        `${s.room} · ${receiptTime(s.started_at, zone)} to ${s.ended_at ? receiptTime(s.ended_at, zone) : "close-out"} · ${s.billable_guests} guests · ${money(Number(s.hourly_cents))} an hour`,
      );
  }
  const bookingId = check?.booking_id ?? null;
  const policy = bookingId
    ? (
        await c.query<{
          version_id: string | null;
          accepted_at: string | null;
          ip: string | null;
          ua: string | null;
        }>(
          `select policy_version_id as version_id, to_json(accepted_at) #>> '{}' as accepted_at,
                  host(accepted_ip) as ip, accepted_ua as ua
             from bookings where venue_id = $1 and id = $2`,
          [venueId, bookingId],
        )
      ).rows[0]
    : undefined;
  const photos = check
    ? (
        await c.query<{ file_id: string }>(
          "select file_id from check_lines where venue_id = $1 and check_id = $2 and kind = 'damage' and file_id is not null",
          [venueId, check.id],
        )
      ).rows.map((r) => r.file_id)
    : [];
  const served = check
    ? (
        await c.query<{
          items: string;
          accepted_by: string | null;
          accepted_at: string | null;
          delivered_by: string | null;
          delivered_at: string | null;
        }>(
          `select (select string_agg(i.qty || ' × ' || i.name_snapshot, ', ' order by i.sort, i.id) from order_items i
                    where i.venue_id = o.venue_id and i.order_id = o.id) as items,
                  ua.name as accepted_by, to_json(o.accepted_at) #>> '{}' as accepted_at,
                  ud.name as delivered_by, to_json(o.delivered_at) #>> '{}' as delivered_at
             from orders o
             left join users ua on ua.id = o.accepted_by
             left join users ud on ud.id = o.delivered_by
            where o.venue_id = $1 and o.check_id = $2 and o.accepted_at is not null
            order by o.accepted_at`,
          [venueId, check.id],
        )
      ).rows.map(
        (o) =>
          `${o.items ?? "Order"} · accepted by ${o.accepted_by ?? "staff"}${o.accepted_at ? ` at ${receiptTime(o.accepted_at, zone)}` : ""}${o.delivered_by ? ` · delivered by ${o.delivered_by}${o.delivered_at ? ` at ${receiptTime(o.delivered_at, zone)}` : ""}` : ""}`,
      )
    : [];
  return {
    checkId: check?.id ?? null,
    fileIds: photos,
    evidence: {
      receipt: check ? { check_id: check.id, number: `#${check.number}` } : null,
      clock,
      policy: policy?.version_id
        ? {
            version_id: policy.version_id,
            accepted_at: policy.accepted_at,
            ip: policy.ip,
            ua: policy.ua,
          }
        : null,
      damage_photos: photos,
      served,
      note: null,
    },
  };
}

interface Deps {
  readonly pool: pg.Pool;
  readonly stripe: StripeClient;
}

/** `charge.dispute.created`: the item opens with its evidence gathered, once per dispute. */
async function opened(deps: Deps, venueId: string, disputeId: string, now: Temporal.Instant) {
  const inVenue = <T>(work: (c: Queryable) => Promise<T>) =>
    withVenue(deps.pool, { venueId, requestId: `dispute:${disputeId}` }, work);
  const account = await inVenue((c) => stripeAccountOf(c, venueId));
  if (!account) return;
  const d = await deps.stripe.call<StripeDispute>(
    "payments",
    "GET",
    `/v1/disputes/${encodeURIComponent(disputeId)}`,
    {
      account,
    },
  );
  await inVenue(async (c) => {
    const payment = d.payment_intent ? await paymentByIntent(c, venueId, d.payment_intent) : null;
    const gathered = payment
      ? await gatherEvidence(c, venueId, payment.id)
      : { checkId: null, fileIds: [], evidence: emptyEvidence };
    const due = d.evidence_details?.due_by
      ? Temporal.Instant.fromEpochMilliseconds(d.evidence_details.due_by * 1000).toString()
      : null;
    const r = await c.query(
      `insert into disputes (venue_id, payment_id, check_id, stripe_dispute_id, reason, amount_cents, status, due_by,
         evidence, evidence_file_ids, opened_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (stripe_dispute_id) do nothing`,
      [
        venueId,
        payment?.id ?? null,
        gathered.checkId,
        d.id,
        d.reason,
        d.amount,
        d.status,
        due,
        JSON.stringify(gathered.evidence),
        gathered.fileIds,
        now.toString(),
      ],
    );
    if ((r.rowCount ?? 0) > 0)
      await emitEvent(c, {
        venueId,
        type: "dispute.updated",
        entityId: d.id,
        entityVersion: 0,
        audience: "managers",
      });
  });
}
const emptyEvidence: Evidence = {
  receipt: null,
  clock: [],
  policy: null,
  damage_photos: [],
  served: [],
  note: null,
};

/** `charge.dispute.closed`: won or lost, read from Stripe now. */
async function closed(deps: Deps, venueId: string, disputeId: string, now: Temporal.Instant) {
  const inVenue = <T>(work: (c: Queryable) => Promise<T>) =>
    withVenue(deps.pool, { venueId, requestId: `dispute:${disputeId}` }, work);
  const account = await inVenue((c) => stripeAccountOf(c, venueId));
  if (!account) return;
  const d = await deps.stripe.call<StripeDispute>(
    "payments",
    "GET",
    `/v1/disputes/${encodeURIComponent(disputeId)}`,
    {
      account,
    },
  );
  const outcome = d.status === "won" ? "won" : d.status === "lost" ? "lost" : null;
  await inVenue((c) =>
    c.query(
      `update disputes set status = $3, outcome = coalesce($4, outcome), closed_at = coalesce(closed_at, $5)
        where venue_id = $1 and stripe_dispute_id = $2`,
      [venueId, disputeId, d.status, outcome, outcome ? now.toString() : null],
    ),
  );
}

stripeEventHandlers.set("charge.dispute.created", async (ctx) => {
  const id = (ctx.event.payload["data"] as { object?: { id?: string } } | undefined)?.object?.id;
  if (id) await opened(ctx, ctx.venueId, id, ctx.now);
});
stripeEventHandlers.set("charge.dispute.closed", async (ctx) => {
  const id = (ctx.event.payload["data"] as { object?: { id?: string } } | undefined)?.object?.id;
  if (id) await closed(ctx, ctx.venueId, id, ctx.now);
});
// Funds withdrawn and reinstated: each move once, with its amount, for the journal (M7).
for (const [type, kind] of [
  ["charge.dispute.funds_withdrawn", "withdrawn"],
  ["charge.dispute.funds_reinstated", "reinstated"],
] as const)
  stripeEventHandlers.set(type, async (ctx) => {
    const d = (ctx.event.payload["data"] as { object?: StripeDispute } | undefined)?.object;
    if (!d?.id) return;
    await ctx.inVenue(async (c) => {
      const row = (
        await c.query<{ id: string }>(
          "select id from disputes where venue_id = $1 and stripe_dispute_id = $2",
          [ctx.venueId, d.id],
        )
      ).rows[0];
      if (!row) throw new Error(`dispute ${d.id} isn't opened yet`); // the job retries after created lands
      await c.query(
        `insert into dispute_funds (venue_id, dispute_id, kind, amount_cents, stripe_event_id, at)
         values ($1, $2, $3, $4, $5, $6) on conflict (stripe_event_id) do nothing`,
        [ctx.venueId, row.id, kind, d.amount, ctx.event.event_id, ctx.now.toString()],
      );
    });
  });

/** The inbox: each open and closed dispute, its deadline, its evidence and its funds. */
export async function disputeInbox(c: Queryable, venueId: string) {
  const rows = await c.query<{
    id: string;
    stripe_dispute_id: string;
    reason: string;
    amount_cents: string;
    status: string;
    due_by: string | null;
    evidence: Evidence;
    submitted_at: string | null;
    outcome: string | null;
    check_id: string | null;
    withdrawn_cents: string;
    reinstated_cents: string;
  }>(
    `select d.id, d.stripe_dispute_id, d.reason, d.amount_cents, d.status, to_json(d.due_by) #>> '{}' as due_by,
            d.evidence, to_json(d.submitted_at) #>> '{}' as submitted_at, d.outcome, d.check_id,
            coalesce((select sum(amount_cents) from dispute_funds f where f.venue_id = d.venue_id and f.dispute_id = d.id and f.kind = 'withdrawn'), 0) as withdrawn_cents,
            coalesce((select sum(amount_cents) from dispute_funds f where f.venue_id = d.venue_id and f.dispute_id = d.id and f.kind = 'reinstated'), 0) as reinstated_cents
       from disputes d where d.venue_id = $1 order by d.closed_at nulls first, d.due_by nulls last, d.opened_at desc`,
    [venueId],
  );
  return rows.rows.map((r) => ({
    ...r,
    amount_cents: Number(r.amount_cents),
    withdrawn_cents: Number(r.withdrawn_cents),
    reinstated_cents: Number(r.reinstated_cents),
  }));
}

/** "Add a note": the one piece staff write themselves; it replaces the last one. */
export async function setDisputeNote(c: Queryable, venueId: string, id: string, note: string) {
  const r = await c.query(
    `update disputes set evidence = jsonb_set(evidence, '{note}', to_jsonb($3::text))
      where venue_id = $1 and id = $2 and submitted_at is null and closed_at is null`,
    [venueId, id, note],
  );
  if ((r.rowCount ?? 0) === 0) throw new ApiError("not_found", "no open dispute to add to");
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/**
 * Submit: the receipt as a PDF and a damage photo go up through Stripe's Files API, the rest as text,
 * then the evidence is submitted. Outside any transaction; each write keyed by the dispute.
 */
export async function submitDispute(
  deps: Deps & {
    readonly clock: { now(): Temporal.Instant };
    readonly s3?: () => S3Settings;
    readonly pdf?: (html: string) => Promise<Uint8Array>;
  },
  venueId: string,
  id: string,
  userId: string,
) {
  const inVenue = <T>(work: (c: Queryable) => Promise<T>) =>
    withVenue(deps.pool, { venueId, requestId: `dispute:${id}:submit` }, work);
  const found = await inVenue(async (c) => {
    const d = (
      await c.query<{
        stripe_dispute_id: string;
        evidence: Evidence;
        due_by: string | null;
        submitted_at: string | null;
        closed_at: string | null;
      }>(
        `select stripe_dispute_id, evidence, to_json(due_by) #>> '{}' as due_by,
                to_json(submitted_at) #>> '{}' as submitted_at, to_json(closed_at) #>> '{}' as closed_at
           from disputes where venue_id = $1 and id = $2`,
        [venueId, id],
      )
    ).rows[0];
    if (!d) throw new ApiError("not_found", "no such dispute");
    if (d.submitted_at || d.closed_at)
      throw new ApiError("invalid_request", "this dispute's evidence is already in");
    const lines = d.evidence.receipt
      ? await receiptModel(c, venueId, d.evidence.receipt.check_id)
      : null;
    const photo = d.evidence.damage_photos[0]
      ? (
          await c.query<{ storage_key: string; content_type: string }>(
            "select storage_key, content_type from files where venue_id = $1 and id = $2",
            [venueId, d.evidence.damage_photos[0]],
          )
        ).rows[0]
      : undefined;
    return {
      d,
      receipt: lines ? receiptText(lines) : null,
      photo,
      account: await stripeAccountOf(c, venueId),
    };
  });
  if (!found.account) throw new ApiError("invalid_request", "this venue has no Stripe account");
  const now = deps.clock.now();
  if (found.d.due_by && Temporal.Instant.compare(Temporal.Instant.from(found.d.due_by), now) <= 0)
    throw new ApiError("invalid_request", "the deadline to answer has passed");
  const upload = (key: string, filename: string, contentType: string, data: Uint8Array) =>
    deps.stripe.call<{ id: string }>("payments", "POST", "/v1/files", {
      account: found.account,
      idempotencyKey: `${id}:${key}`,
      file: { purpose: "dispute_evidence", filename, contentType, data },
    });
  const evidence: Record<string, string> = {};
  if (found.receipt) {
    const html = `<html><body><pre style="font:14px monospace">${found.receipt.map(esc).join("\n")}</pre></body></html>`;
    const pdf = await (deps.pdf ?? htmlToPdf)(html);
    evidence["receipt"] = (await upload("receipt", "receipt.pdf", "application/pdf", pdf)).id;
  }
  if (found.photo && deps.s3) {
    const s3 = deps.s3();
    const object = await s3.client.send(
      new GetObjectCommand({ Bucket: s3.bucketFiles, Key: found.photo.storage_key }),
    );
    const bytes = await object.Body!.transformToByteArray();
    evidence["uncategorized_file"] = (
      await upload("photo", "damage.jpg", found.photo.content_type, bytes)
    ).id;
  }
  const e = found.d.evidence;
  const text = [
    ...(e.clock.length ? ["Room clock:", ...e.clock] : []),
    ...(e.served.length ? ["Served:", ...e.served] : []),
    ...(e.note ? ["Note:", e.note] : []),
  ].join("\n");
  if (text) evidence["uncategorized_text"] = text.slice(0, 20000);
  if (e.policy)
    evidence["refund_policy_disclosure"] =
      `The guest accepted policy ${e.policy.version_id}${e.policy.accepted_at ? ` at ${e.policy.accepted_at}` : ""}${e.policy.ip ? ` from ${e.policy.ip}` : ""}.`;
  const sent = await deps.stripe.call<{ status: string }>(
    "payments",
    "POST",
    `/v1/disputes/${encodeURIComponent(found.d.stripe_dispute_id)}`,
    { account: found.account, idempotencyKey: `${id}:submit`, params: { evidence, submit: true } },
  );
  await inVenue((c) =>
    c.query(
      "update disputes set submitted_at = $3, submitted_by = $4, status = $5 where venue_id = $1 and id = $2",
      [venueId, id, now.toString(), userId, sent.status],
    ),
  );
  return { status: sent.status, evidence_sent: Object.keys(evidence) };
}
