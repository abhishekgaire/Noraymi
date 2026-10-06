import { emitEvent, insertPrintJob, type Queryable } from "@west4/db";
import { cents, formatMoney, type Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { checkView } from "../rooms/checks.js";
import { moveTab } from "./state.js";

/**
 * The tab slip (M6-06; Payment flows · The consent line; screens N23): the tab,
 * its card and total, and the same consent line that was read out at opening,
 * taken from the tab's own `policy_versions` row, never rebuilt from tonight's
 * settings. Laid out as receipt lines (print/ticket.ts · receiptPrintLines),
 * and printed at the bar as the paper tip slip (M6-09).
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

export async function tabSlip(
  c: Queryable,
  venueId: string,
  tabId: string,
  now: Temporal.Instant,
  /** What the guest owes before the tip, when the tab is closing (its balance). */
  totalCents?: number,
) {
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
  const total = totalCents ?? view.totals?.total_cents ?? 0;
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

/**
 * Prints the paper tip slip at the bar and moves the tab to `awaiting_tip` (M6-09; Payment flows step 5):
 * a reader that's offline, a guest who asks for a slip, a tip screen untouched for 2 minutes, or a venue
 * whose bar tabs tip on paper. The hold stays; the tip goes in later from Tips to enter. Inside the
 * caller's transaction, with the Close row already in state `slip`.
 */
export async function printSlip(
  c: Queryable,
  venueId: string,
  input: { tabId: string; checkId: string; totalCents: number; now: Temporal.Instant },
) {
  await moveTab(c, venueId, input.tabId, "awaiting_tip");
  const slip = await tabSlip(c, venueId, input.tabId, input.now, input.totalCents);
  await insertPrintJob(c, venueId, {
    checkId: input.checkId,
    kind: "receipt",
    station: "bar",
    payload: { lines: slip.lines },
    createdAt: input.now.toString(),
  });
  await emitEvent(c, { venueId, type: "tab.updated", entityId: input.tabId });
  await emitEvent(c, { venueId, type: "tab.awaiting_tip", entityId: input.tabId });
}
