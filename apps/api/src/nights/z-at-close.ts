import { insertPrintJob, readSetting, type Queryable } from "@west4/db";
import { Temporal, zReportAtClose } from "@west4/shared";
import { isAllowed } from "../email/policy.js";
import type { EmailSettings } from "../email/settings.js";
import { enqueueEmail } from "../jobs/send-email.js";
import { nightReport, reportPrintLines } from "./report.js";

/** Dollars as the receipt printer shows them: "$1,060.63", "−$12.00". */
export const printedMoney = (cents: number) =>
  `${cents < 0 ? "−" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface ZAtClose {
  /** The station whose receipt printer took it, or null when the venue has none paired. */
  readonly printed_at: "bar" | "front_desk" | null;
  /** The owners it was queued to. */
  readonly emailed_to: readonly string[];
}

/**
 * "Print and email the Z report at close" (U-15; D133; `pos.zReportAtClose`, on unless turned off):
 * inside the close's transaction, the stored Z report goes to a receipt printer as a `z_report`
 * print job (the closing station's own first, then the front desk's, then the bar's) and is queued
 * to each active owner with an email address, in their language. Nothing outside is called here:
 * the email is a job the worker sends after the commit, keyed on the night and the address so it
 * goes once. Answers null when the venue turned it off.
 */
export async function zReportAtCloseOut(
  c: Queryable,
  input: {
    readonly venueId: string;
    readonly date: string;
    readonly now: Temporal.Instant;
    /** The screen the close was made on: a bar computer prints at the bar. */
    readonly deviceId: string | null;
    readonly email: Pick<EmailSettings, "allowList">;
  },
): Promise<ZAtClose | null> {
  const { venueId, date, now } = input;
  const pos = await readSetting(c, venueId, "pos", Temporal.PlainDate.from(date));
  if (!zReportAtClose(pos?.value)) return null;
  const report = await nightReport(c, venueId, date, now);
  if (report.kind !== "z" || !report.closed) return null;
  const lines = reportPrintLines(report, printedMoney);

  const kind = input.deviceId
    ? (
        await c.query<{ kind: string }>(
          "select kind from devices where venue_id = $1 and id = $2",
          [venueId, input.deviceId],
        )
      ).rows[0]?.kind
    : undefined;
  const printer = (
    await c.query<{ id: string; station: "bar" | "front_desk" }>(
      `select printer_device_id as id, station from cash_drawers
        where venue_id = $1 and printer_device_id is not null and station is not null
        order by station = $2 desc, station = 'front_desk' desc limit 1`,
      [venueId, kind === "bar_computer" ? "bar" : "front_desk"],
    )
  ).rows[0];
  if (printer)
    await insertPrintJob(c, venueId, {
      kind: "z_report",
      station: printer.station,
      deviceId: printer.id,
      payload: { lines },
      createdAt: now.toString(),
    });

  const venue = (
    await c.query<{ name: string }>("select name from venues where id = $1", [venueId])
  ).rows[0]!;
  const owners = (
    await c.query<{ email: string; locale: "en" | "es" }>(
      `select u.email, m.locale from memberships m join users u on u.id = m.user_id
        where m.venue_id = $1 and m.role = 'owner' and m.status = 'active' and u.email is not null
        order by u.name`,
      [venueId],
    )
  ).rows.filter((o) => isAllowed(input.email.allowList, o.email));
  for (const o of owners)
    await enqueueEmail(c, input.email, {
      venueId,
      template: "z_report",
      to: o.email,
      locale: o.locale,
      data: { venueName: venue.name, date, zNumber: report.closed.z_number, lines },
      runAt: now,
      dedupeKey: `z-report:${venueId}:${date}:${o.email}`,
    });
  return { printed_at: printer?.station ?? null, emailed_to: owners.map((o) => o.email) };
}
