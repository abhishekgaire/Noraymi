import { enqueue, type JobHandler, type Queryable, type Schedule } from "@west4/db";
import { businessDate } from "@west4/rules";
import { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { attachFile } from "../files/storage.js";
import { enqueueEmail } from "../jobs/send-email.js";
import { enqueuePush } from "../push/send-push.js";
import type { EmailSettings } from "../email/settings.js";
import { isAllowed } from "../email/policy.js";
import { venueClock } from "../rooms/assignment.js";

/**
 * The license register (M8-09; spec 04 · licenses, spec 08 · Safety; screens
 * N35). Owners and managers keep each license's number, holder, issuing
 * agency, dates, fee, conditions and a copy. Nothing is filled in for a venue:
 * every field but the kind is the owner's to enter from the paper license.
 *
 * A daily job reminds every owner and manager 60, 30 and 7 days before a
 * license's expires_on, by email and push, each reminder once. The ticket's
 * cautious default: email and push, not texts (the venue's texting number is
 * for guests).
 */
export const LICENSE_KINDS = [
  "liquor",
  "ascap",
  "bmi",
  "sesac",
  "gmr",
  "local",
  "health",
  "other",
] as const;
export type LicenseKind = (typeof LICENSE_KINDS)[number];

/** Days before expires_on when a reminder goes, widest first. */
export const REMINDER_DAYS = [60, 30, 7] as const;
export type ReminderDays = (typeof REMINDER_DAYS)[number];

export interface License {
  readonly id: string;
  readonly kind: LicenseKind;
  readonly number: string | null;
  readonly holder: string | null;
  readonly authority: string | null;
  readonly starts_on: string | null;
  readonly expires_on: string | null;
  readonly fee_cents: number | null;
  readonly conditions: string | null;
  readonly file_id: string | null;
  readonly file_type: string | null;
  readonly reminded_at: string | null;
  readonly reminded_days: ReminderDays | null;
  readonly updated_at: string;
  /** Days from the venue's business date to expires_on; negative once expired. */
  readonly days_left: number | null;
}

export interface LicenseFields {
  readonly number?: string | null | undefined;
  readonly holder?: string | null | undefined;
  readonly authority?: string | null | undefined;
  readonly starts_on?: string | null | undefined;
  readonly expires_on?: string | null | undefined;
  readonly fee_cents?: number | null | undefined;
  readonly conditions?: string | null | undefined;
  readonly file_id?: string | null | undefined;
}

const SELECT = `select l.id, l.kind, l.number, l.holder, l.authority,
    to_char(l.starts_on, 'YYYY-MM-DD') as starts_on,
    to_char(l.expires_on, 'YYYY-MM-DD') as expires_on,
    l.fee_cents, l.conditions, l.file_id, f.content_type as file_type,
    l.reminded_at, l.reminded_days, l.updated_at
  from licenses l left join files f on f.venue_id = l.venue_id and f.id = l.file_id`;

type Row = Omit<License, "reminded_at" | "updated_at" | "days_left"> & {
  reminded_at: Date | null;
  updated_at: Date;
};
const daysUntil = (today: Temporal.PlainDate, date: string) =>
  today.until(Temporal.PlainDate.from(date), { largestUnit: "days" }).days;
const shape = (r: Row, today: Temporal.PlainDate): License => ({
  ...r,
  reminded_at: r.reminded_at ? r.reminded_at.toISOString() : null,
  updated_at: r.updated_at.toISOString(),
  days_left: r.expires_on ? daysUntil(today, r.expires_on) : null,
});

/** The venue's business date at `now` (local time minus the cutover). */
export async function venueToday(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
): Promise<Temporal.PlainDate> {
  const clock = await venueClock(c, venueId);
  return businessDate(now, clock.timeZone, clock.dayCutover).businessDate;
}

/** The register, soonest expiry first; a license with no expiry yet comes last. */
export async function listLicenses(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
): Promise<License[]> {
  const today = await venueToday(c, venueId, now);
  const r = await c.query<Row>(
    `${SELECT} where l.venue_id = $1 order by l.expires_on asc nulls last, l.kind, l.created_at`,
    [venueId],
  );
  return r.rows.map((row) => shape(row, today));
}

async function getLicense(
  c: Queryable,
  venueId: string,
  id: string,
  now: Temporal.Instant,
): Promise<License> {
  const r = await c.query<Row>(`${SELECT} where l.venue_id = $1 and l.id = $2`, [venueId, id]);
  if (!r.rows[0]) throw new ApiError("not_found", "no such license");
  return shape(r.rows[0], await venueToday(c, venueId, now));
}

/** A copy must be this venue's license_copy upload; attaching it makes it count (spec 04 · files). */
async function attachCopy(c: Queryable, venueId: string, fileId: string, now: Temporal.Instant) {
  const f = await c.query<{ kind: string }>(
    "select kind from files where venue_id = $1 and id = $2 and removed_at is null",
    [venueId, fileId],
  );
  if (!f.rows[0]) throw new ApiError("not_found", "no such file");
  if (f.rows[0].kind !== "license_copy")
    throw new ApiError("invalid_request", "a license's copy is a license_copy upload", {
      details: { reason: "file_kind" },
    });
  await attachFile(c, venueId, fileId, now);
}

function checkDates(starts: string | null | undefined, expires: string | null | undefined) {
  if (starts && expires && Temporal.PlainDate.compare(starts, expires) > 0)
    throw new ApiError("invalid_request", "a license can't expire before it starts", {
      details: { reason: "dates" },
    });
}

export async function createLicense(
  c: Queryable,
  venueId: string,
  input: LicenseFields & { kind: LicenseKind; userId: string | null; now: Temporal.Instant },
): Promise<License> {
  checkDates(input.starts_on, input.expires_on);
  if (input.file_id) await attachCopy(c, venueId, input.file_id, input.now);
  const r = await c.query<{ id: string }>(
    `insert into licenses (venue_id, kind, number, holder, authority, starts_on, expires_on, fee_cents,
       conditions, file_id, created_by, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12) returning id`,
    [
      venueId,
      input.kind,
      input.number ?? null,
      input.holder ?? null,
      input.authority ?? null,
      input.starts_on ?? null,
      input.expires_on ?? null,
      input.fee_cents ?? null,
      input.conditions ?? null,
      input.file_id ?? null,
      input.userId,
      input.now.toString(),
    ],
  );
  return getLicense(c, venueId, r.rows[0]!.id, input.now);
}

const COLUMNS = [
  "number",
  "holder",
  "authority",
  "starts_on",
  "expires_on",
  "fee_cents",
  "conditions",
  "file_id",
] as const;

/** Changes only the fields sent. A new expiry (a renewal) starts the reminders over. */
export async function updateLicense(
  c: Queryable,
  venueId: string,
  id: string,
  input: LicenseFields & { now: Temporal.Instant },
): Promise<License> {
  const before = await getLicense(c, venueId, id, input.now);
  const starts = input.starts_on !== undefined ? input.starts_on : before.starts_on;
  const expires = input.expires_on !== undefined ? input.expires_on : before.expires_on;
  checkDates(starts, expires);
  if (input.file_id && input.file_id !== before.file_id)
    await attachCopy(c, venueId, input.file_id, input.now);
  const sets: string[] = [];
  const values: unknown[] = [venueId, id];
  for (const col of COLUMNS) {
    if (input[col] === undefined) continue;
    values.push(input[col]);
    sets.push(`${col} = $${values.length}`);
  }
  if (expires !== before.expires_on) sets.push("reminded_at = null", "reminded_days = null");
  values.push(input.now.toString());
  sets.push(`updated_at = $${values.length}`);
  await c.query(`update licenses set ${sets.join(", ")} where venue_id = $1 and id = $2`, values);
  return getLicense(c, venueId, id, input.now);
}

/**
 * Which reminder is due for a license `daysLeft` days from expiry: the
 * narrowest window it's inside, unless that one (or a narrower one) went
 * already. A license entered 20 days out gets the 30-day reminder only; one
 * already expired still gets the 7-day reminder once.
 */
export function reminderDue(daysLeft: number, sent: ReminderDays | null): ReminderDays | null {
  let due: ReminderDays | null = null;
  for (const w of REMINDER_DAYS) if (daysLeft <= w) due = w;
  if (due === null) return null;
  return sent !== null && sent <= due ? null : due;
}

export const LICENSE_REMINDER_KIND = "licenses.remind";

/** Every morning, on each venue's own clock. */
export const licenseReminderSchedule: Schedule = {
  kind: LICENSE_REMINDER_KIND,
  at: "10:00",
  pool: "bulk",
  maxAttempts: 10,
};

interface Recipient {
  readonly user_id: string;
  readonly email: string | null;
  readonly locale: "en" | "es";
}

/**
 * One run for one venue: each license with a reminder due is marked sent and
 * its emails and pushes are queued in the same transaction, so a rerun the
 * same day (or a retry) sends nothing twice. The email and push jobs do the
 * outside calls later, outside this transaction.
 */
export async function sendLicenseReminders(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
  email: Pick<EmailSettings, "allowList">,
): Promise<{ licenseId: string; days: ReminderDays }[]> {
  const today = await venueToday(c, venueId, now);
  const venueName = (
    await c.query<{ name: string }>("select name from venues where id = $1", [venueId])
  ).rows[0]!.name;
  const licenses = await c.query<{
    id: string;
    kind: LicenseKind;
    number: string | null;
    expires_on: string;
    reminded_days: ReminderDays | null;
  }>(
    `select id, kind, number, to_char(expires_on, 'YYYY-MM-DD') as expires_on, reminded_days
       from licenses where venue_id = $1 and expires_on is not null
       order by expires_on, id for update`,
    [venueId],
  );
  const sent: { licenseId: string; days: ReminderDays }[] = [];
  let recipients: Recipient[] | null = null;
  for (const l of licenses.rows) {
    const daysLeft = daysUntil(today, l.expires_on);
    const due = reminderDue(daysLeft, l.reminded_days);
    if (due === null) continue;
    recipients ??= (
      await c.query<Recipient>(
        `select m.user_id, u.email, m.locale from memberships m join users u on u.id = m.user_id
          where m.venue_id = $1 and m.role in ('owner', 'manager') and m.status = 'active'
          order by m.role, u.name`,
        [venueId],
      )
    ).rows;
    await c.query(
      "update licenses set reminded_at = $3, reminded_days = $4 where venue_id = $1 and id = $2",
      [venueId, l.id, now.toString(), due],
    );
    for (const to of recipients) {
      const key = `license-reminder:${l.id}:${l.expires_on}:${due}:${to.user_id}`;
      await enqueuePush(c, {
        venueId,
        audience: { kind: "person", userId: to.user_id },
        message: {
          key: `licenses.push.${l.kind}`,
          params: { date: l.expires_on },
          url: "/admin/licenses",
          tag: `license-${l.id}`,
        },
        runAt: now,
        dedupeKey: `${key}:push`,
      });
      // On staging an address outside the allow-list is skipped, never a failed run.
      if (to.email && isAllowed(email.allowList, to.email))
        await enqueueEmail(c, email, {
          venueId,
          to: to.email,
          locale: to.locale,
          template: "license_reminder",
          data: {
            venueName,
            kind: l.kind,
            number: l.number ?? "",
            expiresOn: l.expires_on,
            daysLeft: Math.max(daysLeft, 0),
          },
          runAt: now,
          dedupeKey: `${key}:email`,
        });
    }
    sent.push({ licenseId: l.id, days: due });
  }
  return sent;
}

export function makeLicenseReminderHandler(email: Pick<EmailSettings, "allowList">): JobHandler {
  return async ({ job, clock, step }) => {
    // The venue comes from the job row, never the payload.
    await step((c) => sendLicenseReminders(c, job.venue_id, clock.now(), email));
  };
}

/** For tests and the wall suite: queue today's run for one venue. */
export async function enqueueLicenseReminders(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
): Promise<string | null> {
  return enqueue(c, {
    venueId,
    kind: LICENSE_REMINDER_KIND,
    pool: "bulk",
    runAt: now,
    payload: {},
  });
}
