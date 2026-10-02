import { PAY_HEADERS, PAY_SCRIPTS } from "./pay-policy";

/**
 * The changed-script and header check (M4-15; Security 1): the live payment
 * page against its policy. Every script must be on the list (the page's own
 * bundle with subresource integrity in production, Stripe.js), every inline
 * script must carry the CSP's nonce, the headers must be there, and nothing
 * may register a service worker. Returns what's wrong; an empty list passes.
 */
export function checkPayPage(input: {
  html: string;
  headers: Readonly<Record<string, string | undefined>>;
  /** Production builds carry integrity on our own scripts; the dev server doesn't. */
  requireIntegrity: boolean;
}): string[] {
  const problems: string[] = [];
  const header = (name: string) => input.headers[name.toLowerCase()] ?? input.headers[name];
  const csp = header("content-security-policy") ?? "";
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
  if (!nonce) problems.push("the Content-Security-Policy has no nonce");
  if (!/frame-ancestors 'none'/.test(csp))
    problems.push("the Content-Security-Policy lacks frame-ancestors 'none'");
  for (const [name, value] of Object.entries(PAY_HEADERS))
    if (!(header(name) ?? "").includes(value)) problems.push(`the ${name} header isn't "${value}"`);
  for (const tag of input.html.match(/<script\b[^>]*>/gi) ?? []) {
    const src = /\ssrc="([^"]+)"/i.exec(tag)?.[1];
    const tagNonce = /\snonce="([^"]*)"/i.exec(tag)?.[1];
    if (!src) {
      // React and Next.js put the nonce on their inline scripts; a listed inline script without it is a change.
      if (nonce && tagNonce !== nonce && !/type="application\/(ld\+)?json"/i.test(tag))
        problems.push(`an inline script without the page's nonce: ${tag}`);
      continue;
    }
    const path = src.replace(/^https?:\/\/(pay\.[^/]+|localhost(:\d+)?)(?=\/)/i, "");
    const listed = PAY_SCRIPTS.find((s) => new RegExp(s.match).test(path));
    if (!listed) {
      problems.push(`an unlisted script: ${src}`);
      continue;
    }
    if (
      input.requireIntegrity &&
      path.startsWith("/_next/") &&
      !/\sintegrity="sha(256|384|512)-/i.test(tag)
    )
      problems.push(`our script has no integrity: ${src}`);
  }
  if (/serviceWorker\s*\.\s*register/.test(input.html))
    problems.push("the page registers a service worker");
  return problems;
}
