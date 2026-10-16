import { emitEvent, latestSetting, rulePackFor, type Queryable } from "@west4/db";
import {
  businessDate,
  exemptTax,
  salesTaxRule,
  type SalesTaxRule,
  type TaxCategory,
} from "@west4/rules";
import { TAX_EXEMPT_DEFAULTS, Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import {
  declineHandlers,
  executors,
  requestApproval,
  TargetGone,
  type ApprovalAnswer,
} from "../approvals/service.js";
import { venueClock } from "./assignment.js";

/**
 * Tax-exempt checks (P-15; Money rules 8; module tax_exempt, off by default). A room's check or a
 * bar tab is made tax exempt with the organization's name and its exemption certificate number,
 * both required, and a manager's approval per the venue's setting (phone, PIN or none); it's written
 * only once approved. Each finalize then taxes only the categories the venue keeps taxed on an exempt
 * check (`taxExempt.stillTaxed`, drinks by default: which sales an exemption covers is the
 * accountant's question), as they stood when the exemption was given. One stands on a check at a
 * time; removing it is allowed while the check is open, before payment. Both are in the audit log.
 */
export interface TaxExemptPayload {
  readonly check_id: string;
  readonly organization: string;
  readonly certificate_no: string;
  readonly still_taxed: readonly TaxCategory[];
}

export interface StandingExemption {
  readonly id: string;
  readonly organization: string;
  readonly certificate_no: string;
  readonly still_taxed: TaxCategory[];
  readonly added_by_name: string | null;
  readonly approved_by_name: string | null;
}

export async function standingExemption(
  c: Queryable,
  venueId: string,
  checkId: string,
): Promise<StandingExemption | null> {
  const r = await c.query<StandingExemption>(
    `select e.id, e.organization, e.certificate_no, e.still_taxed, u.name as added_by_name,
            a.name as approved_by_name
       from check_tax_exemptions e
       left join users u on u.id = e.added_by
       left join users a on a.id = e.approved_by
      where e.venue_id = $1 and e.check_id = $2 and e.removed_at is null`,
    [venueId, checkId],
  );
  return r.rows[0] ?? null;
}

/** The check's sales tax: the pack's, or only what stays taxed while an exemption stands on it. */
export async function checkTax(
  c: Queryable,
  venueId: string,
  checkId: string,
  tax: SalesTaxRule,
): Promise<SalesTaxRule> {
  const e = await standingExemption(c, venueId, checkId);
  return e ? exemptTax(tax, e.still_taxed) : tax;
}

async function openCheck(c: Queryable, venueId: string, checkId: string) {
  const locked = await c.query<{ status: string; kind: string }>(
    "select status, kind from checks where venue_id = $1 and id = $2 for update",
    [venueId, checkId],
  );
  return locked.rows[0] ?? null;
}

async function writeExemption(
  c: Queryable,
  venueId: string,
  p: TaxExemptPayload,
  who: { addedBy: string; approvedBy: string | null; at: Temporal.Instant },
): Promise<void> {
  const v = await venueClock(c, venueId);
  const night = businessDate(who.at, v.timeZone, v.dayCutover).businessDate.toString();
  await c.query(
    `insert into check_tax_exemptions (venue_id, check_id, business_date, organization, certificate_no,
       still_taxed, added_by, added_at, approved_by)
     values ($1, $2, open_business_date($1, $3::date), $4, $5, $6::text[], $7, $8, $9)`,
    [
      venueId,
      p.check_id,
      night,
      p.organization,
      p.certificate_no,
      [...p.still_taxed],
      who.addedBy,
      who.at.toString(),
      who.approvedBy,
    ],
  );
  await emitEvent(c, { venueId, type: "check.updated", entityId: p.check_id, entityVersion: 0 });
}

/** Asks for a check to be made tax exempt: it waits for a manager per the venue's approval setting. */
export async function askTaxExempt(
  c: Queryable,
  venueId: string,
  input: {
    checkId: string;
    organization: string;
    certificateNo: string;
    userId: string;
    deviceId: string | null;
    now: Temporal.Instant;
  },
): Promise<ApprovalAnswer> {
  const organization = input.organization.trim();
  const certificateNo = input.certificateNo.trim();
  if (!organization)
    throw new ApiError("invalid_request", "a tax-exempt check needs the organization's name", {
      details: { reason: "organization_missing" },
    });
  if (!certificateNo)
    throw new ApiError(
      "invalid_request",
      "a tax-exempt check needs the exemption certificate number",
      { details: { reason: "certificate_missing" } },
    );
  const check = await openCheck(c, venueId, input.checkId);
  if (!check) throw new ApiError("not_found", "no such check");
  if (check.kind !== "room" && check.kind !== "bar")
    throw new ApiError("invalid_request", "tax exempt goes on a room's check or a bar tab");
  if (check.status !== "open")
    throw new ApiError(
      "ordering_closed",
      "this check is closed; once it's paid, a correction is a refund",
    );
  if (await standingExemption(c, venueId, input.checkId))
    throw new ApiError("invalid_request", "this check is already tax exempt", {
      details: { reason: "exempt_standing" },
    });
  const pending = await c.query(
    `select 1 from approvals where venue_id = $1 and status = 'pending' and kind = 'tax_exempt'
        and target_id = $2`,
    [venueId, input.checkId],
  );
  if (pending.rowCount)
    throw new ApiError("approval_pending", "this check is already waiting to be made tax exempt");
  const setting = (await latestSetting(c, venueId, "taxExempt"))?.value ?? TAX_EXEMPT_DEFAULTS;
  const payload: TaxExemptPayload = {
    check_id: input.checkId,
    organization,
    certificate_no: certificateNo,
    still_taxed: setting.stillTaxed,
  };
  const asked = await requestApproval(c, venueId, {
    kind: "tax_exempt",
    targetKind: "check",
    targetId: input.checkId,
    amountCents: null,
    reason: `Tax exempt · ${organization} · Certificate ${certificateNo}`,
    payload: { ...payload, description: `Tax exempt · ${organization}` },
    requestedBy: input.userId,
    requestedDeviceId: input.deviceId,
    now: input.now,
  });
  await emitEvent(c, { venueId, type: "check.updated", entityId: input.checkId, entityVersion: 0 });
  return asked;
}

/** Takes the exemption off an open check (before payment); the next finalize taxes it again. */
export async function removeTaxExempt(
  c: Queryable,
  venueId: string,
  input: { checkId: string; userId: string; now: Temporal.Instant },
): Promise<void> {
  const check = await openCheck(c, venueId, input.checkId);
  if (!check) throw new ApiError("not_found", "no such check");
  if (check.status !== "open")
    throw new ApiError(
      "ordering_closed",
      "this check is closed; once it's paid, a correction is a refund",
    );
  const e = await standingExemption(c, venueId, input.checkId);
  if (!e) throw new ApiError("not_found", "this check isn't tax exempt");
  await c.query(
    "update check_tax_exemptions set removed_by = $3, removed_at = $4 where venue_id = $1 and id = $2",
    [venueId, e.id, input.userId, input.now.toString()],
  );
  await emitEvent(c, { venueId, type: "check.updated", entityId: input.checkId, entityVersion: 0 });
}

/** What the check view shows: the exemption standing on it, or one waiting for approval. */
export async function taxExemptView(c: Queryable, venueId: string, checkId: string) {
  const e = await standingExemption(c, venueId, checkId);
  const waiting = (
    await c.query<{ name: string; payload: TaxExemptPayload }>(
      `select u.name, a.payload from approvals a join users u on u.id = a.routed_to
        where a.venue_id = $1 and a.target_id = $2 and a.status = 'pending' and a.kind = 'tax_exempt'
        limit 1`,
      [venueId, checkId],
    )
  ).rows[0];
  return {
    tax_exempt: e
      ? {
          organization: e.organization,
          certificate_no: e.certificate_no,
          still_taxed: e.still_taxed,
          added_by: e.added_by_name,
          approved_by: e.approved_by_name,
        }
      : null,
    pending_tax_exempt: waiting
      ? { waiting_for: waiting.name, organization: waiting.payload.organization }
      : null,
  };
}

/** Approved: the exemption is written as asked, if the check is still open and has none. */
executors.set("tax_exempt", async (c, venueId, approval, ctx) => {
  const p = approval.payload as unknown as TaxExemptPayload;
  const check = await openCheck(c, venueId, p.check_id);
  if (!check || check.status !== "open" || (await standingExemption(c, venueId, p.check_id)))
    throw new TargetGone();
  await writeExemption(c, venueId, p, {
    addedBy: approval.requested_by,
    approvedBy: ctx.approverId,
    at: ctx.at,
  });
});

/** Declined: nothing changes, but every screen showing the check drops "Waiting for Andy". */
declineHandlers.set("tax_exempt", async (c, venueId, approval) => {
  const p = approval.payload as { check_id?: string };
  if (!p.check_id) return;
  await emitEvent(c, { venueId, type: "check.updated", entityId: p.check_id, entityVersion: 0 });
});

/** One tax-exempt check of a night, as the Z report, the tax quarter and the money audit list it. */
export interface ExemptSale {
  readonly business_date: string;
  readonly check: string;
  readonly where: string;
  readonly organization: string;
  readonly certificate_no: string;
  readonly asked_by: string | null;
  readonly approved_by: string | null;
  /** The sales the exemption left untaxed: its lines in the categories the pack taxes and it didn't. */
  readonly exempt_sales_cents: number;
}

/** Every tax-exempt check whose business date is from `from` to `to` (practice left out). */
export async function exemptSales(
  c: Queryable,
  venueId: string,
  from: string,
  to: string,
): Promise<ExemptSale[]> {
  const rows = await c.query<{
    business_date: string;
    check: string;
    where: string;
    organization: string;
    certificate_no: string;
    still_taxed: TaxCategory[];
    asked_by: string | null;
    approved_by: string | null;
    by_category: Record<string, string> | null;
  }>(
    `select k.business_date::text, '#' || k.number as check,
            coalesce((select r.name from room_sessions rs join rooms r on r.venue_id = rs.venue_id and r.id = rs.room_id
                       where rs.venue_id = k.venue_id and rs.id = k.room_session_id),
                     (select t.name from tabs t where t.venue_id = k.venue_id and t.check_id = k.id),
                     '#' || k.number) as where,
            e.organization, e.certificate_no, e.still_taxed, ru.name as asked_by, au.name as approved_by,
            (select jsonb_object_agg(x.cat, x.cents::text) from (
               select l.tax_category as cat, sum(l.amount_cents) as cents from live_check_lines l
                where l.venue_id = k.venue_id and l.check_id = k.id and l.tax_category is not null
                  and l.kind not in ('tax', 'gratuity', 'refund')
                group by l.tax_category) x) as by_category
       from check_tax_exemptions e
       join live_checks k on k.venue_id = e.venue_id and k.id = e.check_id
       left join users ru on ru.id = e.added_by
       left join users au on au.id = e.approved_by
      where e.venue_id = $1 and e.removed_at is null
        and k.business_date between $2::date and $3::date
      order by k.business_date, k.number`,
    [venueId, from, to],
  );
  if (rows.rows.length === 0) return [];
  const packId =
    (
      await c.query<{ p: string | null }>("select rule_pack_id as p from venues where id = $1", [
        venueId,
      ])
    ).rows[0]?.p ?? "us-ny-new-york-county";
  const taxedOn = new Map<string, readonly TaxCategory[]>();
  const out: ExemptSale[] = [];
  for (const r of rows.rows) {
    if (!taxedOn.has(r.business_date)) {
      const pack = await rulePackFor(c, packId, Temporal.PlainDate.from(r.business_date));
      taxedOn.set(r.business_date, pack ? salesTaxRule(pack.pack).taxedCategories : []);
    }
    const untaxed = taxedOn.get(r.business_date)!.filter((cat) => !r.still_taxed.includes(cat));
    const cents = Object.entries(r.by_category ?? {})
      .filter(([cat]) => untaxed.includes(cat as TaxCategory))
      .reduce((sum, [, v]) => sum + Number(v), 0);
    out.push({
      business_date: r.business_date,
      check: r.check,
      where: r.where,
      organization: r.organization,
      certificate_no: r.certificate_no,
      asked_by: r.asked_by,
      approved_by: r.approved_by,
      exempt_sales_cents: Math.max(0, cents),
    });
  }
  return out;
}
