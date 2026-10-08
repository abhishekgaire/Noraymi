/**
 * The DNS, TLS and redirect check around the domain move (M9-09;
 * docs/runbooks/domain-move.md). The pure parts live here so they're tested;
 * scripts/check-domain.ts does the network calls.
 */

/** The email records that must survive the move, as read before and after. */
export interface MailRecords {
  readonly mx: readonly string[];
  readonly spf: readonly string[];
  readonly dmarc: readonly string[];
  readonly dkim: Readonly<Record<string, readonly string[]>>;
}

const sorted = (xs: readonly string[]) => [...xs].map((x) => x.trim().toLowerCase()).sort();
const same = (a: readonly string[], b: readonly string[]) =>
  JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

/** Every email record that changed or vanished since the snapshot, in words. */
export function mailChanges(before: MailRecords, after: MailRecords): string[] {
  const out: string[] = [];
  if (!same(before.mx, after.mx))
    out.push(`MX changed: ${before.mx.join(", ")} → ${after.mx.join(", ") || "none"}`);
  if (!same(before.spf, after.spf))
    out.push(`SPF changed: ${before.spf.join(" ")} → ${after.spf.join(" ") || "none"}`);
  if (!same(before.dmarc, after.dmarc))
    out.push(`DMARC changed: ${before.dmarc.join(" ")} → ${after.dmarc.join(" ") || "none"}`);
  for (const [selector, value] of Object.entries(before.dkim))
    if (!same(value, after.dkim[selector] ?? [])) out.push(`DKIM ${selector} changed or missing`);
  return out;
}

/** What an old URL answered: its first status and the final one after redirects. */
export interface UrlAnswer {
  readonly url: string;
  readonly first: number;
  readonly final: number;
}

/** An old URL fails when anything along the way is a 4xx or 5xx. */
export function urlProblems(answers: readonly UrlAnswer[]): string[] {
  return answers
    .filter((a) => a.first >= 400 || a.final >= 400)
    .map((a) => `${a.url} answered ${a.first}${a.first !== a.final ? ` then ${a.final}` : ""}`);
}

/** Days until a certificate's expiry; under 14 is a problem on the day of the move. */
export function certDaysLeft(validTo: string, now: Date): number {
  return Math.floor((new Date(validTo).getTime() - now.getTime()) / 86_400_000);
}
