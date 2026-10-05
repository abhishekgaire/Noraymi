import type { Queryable } from "@west4/db";
import { cents, formatMoney, type Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { checkView } from "../rooms/checks.js";

/**
 * The tab slip (M6-06; Payment flows · The consent line; screens N23): the tab,
 * its card and total, and the same consent line that was read out at opening,
 * taken from the tab's own `policy_versions` row, never rebuilt from tonight's
 * settings. Laid out as receipt lines (print/ticket.ts · receiptPrintLines);
 * printing it as the paper tip slip comes with M6-09.
 */
const WIDTH = 32;

/** Words wrapped to the printer's 32 columns. */
export function wrapWords(text: string, width = WIDTH): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out;
}

export async function tabSlip(c: Queryable, venueId: string, tabId: string, now: Temporal.Instant) {
  const tab = (
    await c.query<{
      name: string;
      check_id: string;
      card_brand: string | null;
      card_last4: string | null;
      consent: string | null;
    }>(
      `select t.name, t.check_id, t.card_brand, t.card_last4, p.text as consent
         from tabs t left join policy_versions p on p.venue_id = t.venue_id and p.id = t.consent_text_version
        where t.venue_id = $1 and t.id = $2`,
      [venueId, tabId],
    )
  ).rows[0];
  if (!tab) throw new ApiError("not_found", "no such tab");
  const view = await checkView(c, venueId, tab.check_id, now);
  const total = view.totals?.total_cents ?? 0;
  const lines = [
    tab.name,
    ...(tab.card_last4 ? [`${tab.card_brand ?? ""} ··${tab.card_last4}`.trim()] : []),
    "",
    `Total  ${formatMoney("en", cents(total))}`,
    "",
    ...(tab.consent ? [...wrapWords(tab.consent), ""] : []),
    "Tip  ____________",
    "Total  ____________",
    "",
    "Signature  ____________",
  ];
  return { lines, consent: tab.consent };
}
