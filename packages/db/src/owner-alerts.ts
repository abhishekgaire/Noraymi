import { Temporal } from "@west4/shared";
import { enqueue } from "./jobs/queue.js";
import { readSetting } from "./settings.js";
import type { Queryable } from "./tenancy.js";

/**
 * Alerts to the venue's owner (M8-19; spec 02 · Approvals, On the record; spec 12 · 12): a void
 * on a check after part of it was paid in cash, and a refund over the venue's set amount
 * (`pos.refundAlertOverCents`; while it isn't set, every refund alerts). Each alert is written
 * once to `owner_alerts` (one row per void line or refund) and pushed to every active owner in
 * the same transaction as the void or refund, so a void that rolls back never alerts. Practice
 * (training) checks and payments never alert. The push job's payload is the staff app's
 * `push.send` shape (apps/api/src/push/send-push.ts · pushJobPayload).
 */
export type OwnerAlertKind = "void_after_cash" | "refund";

const usd = (cents: number) =>
  `$${Math.floor(cents / 100).toLocaleString("en-US")}.${String(cents % 100).padStart(2, "0")}`;

async function alertOwners(
  c: Queryable,
  venueId: string,
  a: {
    kind: OwnerAlertKind;
    sourceKey: string;
    checkId: string | null;
    amountCents: number;
    businessDate: string;
    at: string;
    staff: string;
    check: string;
  },
): Promise<boolean> {
  const made = await c.query<{ id: string }>(
    `insert into owner_alerts (venue_id, kind, source_key, check_id, amount_cents, business_date, created_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (venue_id, source_key) do nothing returning id`,
    [venueId, a.kind, a.sourceKey, a.checkId, a.amountCents, a.businessDate, a.at],
  );
  const id = made.rows[0]?.id;
  if (!id) return false;
  await enqueue(c, {
    venueId,
    kind: "push.send",
    pool: "normal",
    runAt: Temporal.Instant.from(a.at),
    payload: {
      audience: { kind: "role", role: "owner" },
      message: {
        key: a.kind === "refund" ? "push.ownerAlert.refund" : "push.ownerAlert.voidAfterCash",
        params: { amount: usd(a.amountCents), check: a.check, staff: a.staff },
        url: "/close-the-night",
        tag: `owner-alert-${id}`,
      },
    },
    dedupeKey: `owner-alert:${id}`,
    maxAttempts: 3,
  });
  return true;
}

async function checkLabel(c: Queryable, venueId: string, checkId: string | null) {
  if (!checkId) return { label: "", training: false };
  const r = await c.query<{ number: string; training: boolean }>(
    "select number::text, training from checks where venue_id = $1 and id = $2",
    [venueId, checkId],
  );
  const row = r.rows[0];
  return { label: row ? `#${row.number}` : "", training: row?.training ?? false };
}

async function staffName(c: Queryable, userId: string | null) {
  if (!userId) return "";
  const r = await c.query<{ name: string }>("select name from users where id = $1", [userId]);
  return r.rows[0]?.name ?? "";
}

/** After a void line is written: alerts the owner when the check already has cash paid on it. */
export async function alertVoidAfterCash(
  c: Queryable,
  venueId: string,
  v: {
    lineId: number;
    checkId: string;
    amountCents: number;
    businessDate: string;
    at: string;
    addedBy: string | null;
  },
): Promise<boolean> {
  const cash = await c.query(
    `select 1 from payment_allocations a
       join payments p on p.venue_id = a.venue_id and p.id = a.payment_id
      where a.venue_id = $1 and a.check_id = $2 and a.kind = 'payment' and a.state = 'captured'
        and a.amount_cents > 0 and p.method = 'cash' and not p.training
      limit 1`,
    [venueId, v.checkId],
  );
  if (!cash.rowCount) return false;
  const check = await checkLabel(c, venueId, v.checkId);
  if (check.training) return false;
  return alertOwners(c, venueId, {
    kind: "void_after_cash",
    sourceKey: `void:${v.lineId}`,
    checkId: v.checkId,
    amountCents: Math.abs(v.amountCents),
    businessDate: v.businessDate,
    at: v.at,
    staff: await staffName(c, v.addedBy),
    check: check.label,
  });
}

/** After a refund is recorded: alerts the owner when it's over the set amount (every one while unset). */
export async function alertRefund(
  c: Queryable,
  venueId: string,
  r: {
    refundId: string;
    paymentId: string;
    checkId: string | null;
    amountCents: number;
    businessDate: string;
    at: string;
    requestedBy: string | null;
  },
): Promise<boolean> {
  const pay = await c.query<{ training: boolean }>(
    "select training from payments where venue_id = $1 and id = $2",
    [venueId, r.paymentId],
  );
  if (pay.rows[0]?.training) return false;
  const pos = await readSetting(c, venueId, "pos", Temporal.PlainDate.from(r.businessDate));
  const over = pos?.value.refundAlertOverCents;
  if (over !== undefined && r.amountCents <= over) return false;
  const check = await checkLabel(c, venueId, r.checkId);
  return alertOwners(c, venueId, {
    kind: "refund",
    sourceKey: `refund:${r.refundId}`,
    checkId: r.checkId,
    amountCents: r.amountCents,
    businessDate: r.businessDate,
    at: r.at,
    staff: await staffName(c, r.requestedBy),
    check: check.label,
  });
}
