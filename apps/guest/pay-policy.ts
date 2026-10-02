/**
 * The payment page's security policy (M4-15; Security 1): the scripts it may
 * load, each with its reason, and the headers it must send. The proxy builds
 * the headers from it; `scripts/check-pay-page.mjs` checks the live page
 * against it on every deploy and weekly.
 */
export const PAY_SCRIPTS = [
  {
    match: "^/_next/static/",
    reason: "the page's own bundle (Next.js), with subresource integrity in production",
  },
  {
    match: "^https://js\\.stripe\\.com/v3/?$",
    reason: "Stripe.js, which mounts the Payment Element (card details stay in Stripe's frame)",
  },
] as const;

export function payCsp(nonce: string, dev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://js.stripe.com${dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'${dev ? " 'unsafe-inline'" : ""}`,
    "img-src 'self' data: https://*.stripe.com",
    "font-src 'self'",
    "connect-src 'self' https://api.stripe.com https://r.stripe.com",
    "frame-src https://js.stripe.com https://hooks.stripe.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

export const PAY_HEADERS: Readonly<Record<string, string>> = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
