import type { Queryable } from "@west4/db";
import { localeTags, locales, t, type Locale, type Temporal } from "@west4/shared";
import { goLive } from "./go-live.js";

/**
 * The break-glass card (M8-06; spec 09 · Break-glass card; Stripe setup 11; D54): a
 * one-page card per language to print ahead of time and keep at each desk. When our
 * cloud is down, take cards with Tap to Pay in Stripe's Dashboard app on a manager's
 * phone; if Stripe is down too, take cash; afterwards match the payments in Unmatched
 * payments and work through Review after outage. It names the owners and managers
 * ready for Tap to Pay: both go-live checks (M4-29) confirmed. West 4's desks have
 * only receipt printers, so it comes as a letter-size PDF to print ahead of time and a
 * short version for the receipt printer (the ticket's cautious default).
 */
export interface BreakGlassCard {
  readonly venue: string;
  readonly time_zone: string;
  readonly printed_at: string;
  readonly ready: readonly string[];
  readonly not_ready: readonly string[];
}

export async function breakGlassCard(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
): Promise<BreakGlassCard> {
  const v = await c.query<{ name: string; time_zone: string }>(
    "select name, time_zone from venues where id = $1",
    [venueId],
  );
  if (!v.rows[0]) throw new Error(`venue ${venueId} not visible`);
  const { people } = await goLive(c, venueId);
  const isReady = (p: (typeof people)[number]) =>
    p.dashboard_login.confirmed && p.tap_to_pay.confirmed;
  return {
    venue: v.rows[0].name,
    time_zone: v.rows[0].time_zone,
    printed_at: now.toString(),
    ready: people.filter(isReady).map((p) => p.name),
    not_ready: people.filter((p) => !isReady(p)).map((p) => p.name),
  };
}

const escape = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function printedLabel(card: BreakGlassCard, locale: Locale): string {
  const date = new Intl.DateTimeFormat(localeTags[locale], {
    timeZone: card.time_zone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(card.printed_at));
  return t(locale, "breakGlass.card.printed", { date });
}

const LOG_ROWS = 10;

function pageHtml(card: BreakGlassCard, locale: Locale): string {
  const venue = card.venue;
  const say = (key: Parameters<typeof t>[1], params?: Record<string, string>) =>
    escape(t(locale, key, params));
  const ready = card.ready.length
    ? `<ul class="names">${card.ready.map((n) => `<li>${escape(n)}</li>`).join("")}</ul>`
    : `<p class="warn">${say("breakGlass.card.readyNone")}</p>`;
  const notReady = card.not_ready.length
    ? `<p class="small">${say("breakGlass.card.notReady", { names: card.not_ready.join(", ") })}</p>`
    : "";
  const rows = Array.from(
    { length: LOG_ROWS },
    () => "<tr><td></td><td></td><td></td><td></td></tr>",
  ).join("");
  return `<section class="page" lang="${locale}">
<h1>${say("breakGlass.card.title", { venue })}</h1>
<p class="keep">${say("breakGlass.card.keep")}</p>
<h2>1 · ${say("breakGlass.card.cloudDown")}</h2>
<ol><li>${say("breakGlass.card.step1", { venue })}</li><li>${say("breakGlass.card.step2")}</li></ol>
<h2>2 · ${say("breakGlass.card.stripeDown")}</h2>
<p>${say("breakGlass.card.cash")}</p>
<h2>3 · ${say("breakGlass.card.afterwards")}</h2>
<p>${say("breakGlass.card.match")}</p>
<h2>${say("breakGlass.card.readyTitle")}</h2>
${ready}${notReady}
<h2>${say("breakGlass.card.log")}</h2>
<table><thead><tr><th>${say("breakGlass.card.colWhere")}</th><th>${say("breakGlass.card.colAmount")}</th><th>${say("breakGlass.card.colTime")}</th><th>${say("breakGlass.card.colHow")}</th></tr></thead><tbody>${rows}</tbody></table>
<p class="printed">${escape(printedLabel(card, locale))}</p>
</section>`;
}

/** The letter-size card: one page in English, then one in Spanish. */
export function breakGlassHtml(card: BreakGlassCard): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(
    t("en", "breakGlass.card.title", { venue: card.venue }),
  )}</title>
<style>
  body { font-family: "Noto Sans", Helvetica, Arial, sans-serif; color: #111; margin: 0; font-size: 11pt; font-variant-ligatures: none; }
  .page { break-after: page; }
  .page:last-child { break-after: auto; }
  h1 { font-size: 20pt; margin: 0 0 6pt; }
  h2 { font-size: 13pt; margin: 12pt 0 4pt; border-bottom: 1px solid #999; }
  p, ol, ul { margin: 0 0 4pt; }
  .keep { font-weight: bold; }
  .warn { font-weight: bold; }
  .small, .printed { font-size: 9pt; color: #333; }
  .printed { margin-top: 8pt; }
  table { width: 100%; border-collapse: collapse; margin-top: 4pt; }
  th, td { border: 1px solid #666; padding: 3pt 4pt; text-align: left; font-size: 10pt; height: 16pt; }
</style></head><body><main>${locales.map((l) => pageHtml(card, l)).join("")}</main></body></html>`;
}

const WIDTH = 32;

/** Wraps text at word boundaries to the receipt printer's 32 columns. */
export function wrap(text: string, width = WIDTH, indent = ""): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= width) line = next;
    else {
      if (line) out.push(line);
      line = indent + word;
    }
  }
  if (line) out.push(line);
  return out;
}

/** The short version for the front-desk receipt printer: English, then Spanish. */
export function breakGlassLines(card: BreakGlassCard): string[] {
  const out: string[] = [];
  locales.forEach((locale, i) => {
    if (i > 0) out.push("-".repeat(WIDTH));
    const say = (key: Parameters<typeof t>[1], params?: Record<string, string>) =>
      t(locale, key, params);
    out.push(...wrap(say("breakGlass.card.title", { venue: card.venue }).toUpperCase()));
    out.push(...wrap(say("breakGlass.card.keep")));
    out.push("");
    out.push(...wrap(`1 ${say("breakGlass.card.cloudDown")}`));
    out.push(...wrap(`- ${say("breakGlass.card.step1", { venue: card.venue })}`, WIDTH, "  "));
    out.push(...wrap(`- ${say("breakGlass.card.step2")}`, WIDTH, "  "));
    out.push(...wrap(`2 ${say("breakGlass.card.stripeDown")}`));
    out.push(...wrap(`- ${say("breakGlass.card.cash")}`, WIDTH, "  "));
    out.push(...wrap(`3 ${say("breakGlass.card.afterwards")}`));
    out.push(...wrap(`- ${say("breakGlass.card.match")}`, WIDTH, "  "));
    out.push("");
    out.push(...wrap(`${say("breakGlass.card.readyTitle")}:`));
    if (card.ready.length) for (const n of card.ready) out.push(...wrap(`- ${n}`, WIDTH, "  "));
    else out.push(...wrap(say("breakGlass.card.readyNone")));
    if (card.not_ready.length)
      out.push(...wrap(say("breakGlass.card.notReady", { names: card.not_ready.join(", ") })));
    out.push(...wrap(printedLabel(card, locale)));
  });
  return out;
}
