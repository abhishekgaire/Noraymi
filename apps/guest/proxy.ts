import { NextResponse, type NextRequest } from "next/server";
import { PAY_HEADERS, payCsp } from "./pay-policy";

/**
 * The payment page lives only on the `pay.` hostname (M4-15; Security 1):
 * there it gets a fresh nonce, a nonce-based Content Security Policy with
 * `frame-ancestors 'none'`, Cross-Origin-Opener-Policy same-origin and the
 * token headers, and nothing else of the site is served. On any other host
 * `/pay/…` doesn't exist.
 */
const payHost = (process.env["PAY_HOST"] ?? "pay.localhost:3001").toLowerCase();

export function proxy(request: NextRequest) {
  const host = (request.headers.get("host") ?? "").toLowerCase();
  const path = request.nextUrl.pathname;
  const onPay = host === payHost;
  if (!onPay) {
    if (path.startsWith("/pay")) return new NextResponse(null, { status: 404 });
    return NextResponse.next();
  }
  // The pay host serves the payment page, its bundle and its API calls; nothing else.
  if (
    !path.startsWith("/pay/") &&
    !path.startsWith("/_next/") &&
    !path.startsWith("/v1/public/pay/")
  )
    return new NextResponse(null, { status: 404 });
  if (path.startsWith("/_next/") || path.startsWith("/v1/")) return NextResponse.next();
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = payCsp(nonce, process.env.NODE_ENV === "development");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  for (const [k, v] of Object.entries(PAY_HEADERS)) response.headers.set(k, v);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
