import { describe, expect, it } from "vitest";
import { checkPayPage } from "./pay-check";
import { payCsp } from "./pay-policy";

const headers = {
  "content-security-policy": payCsp("abc123", false),
  "cross-origin-opener-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
};
const page = (extra = "") =>
  `<html><head><script src="/_next/static/chunks/main.js" integrity="sha256-xyz" nonce="abc123"></script>` +
  `<script nonce="abc123">self.__next_f=[]</script>${extra}</head><body></body></html>`;

describe("the payment page check", () => {
  it("passes the page as listed, with its headers", () => {
    expect(checkPayPage({ html: page(), headers, requireIntegrity: true })).toEqual([]);
    expect(
      checkPayPage({
        html: page('<script src="https://js.stripe.com/v3/" nonce="abc123"></script>'),
        headers,
        requireIntegrity: true,
      }),
    ).toEqual([]);
  });

  it("fails on an unlisted script added to the page", () => {
    expect(
      checkPayPage({
        html: page('<script src="https://cdn.example.com/analytics.js"></script>'),
        headers,
        requireIntegrity: true,
      }),
    ).toEqual(["an unlisted script: https://cdn.example.com/analytics.js"]);
  });

  it("fails on our script without integrity in production, an inline script without the nonce, and a service worker", () => {
    const html = `<script src="/_next/static/chunks/x.js"></script><script>navigator.serviceWorker.register("/sw.js")</script>`;
    expect(checkPayPage({ html, headers, requireIntegrity: true })).toEqual([
      "our script has no integrity: /_next/static/chunks/x.js",
      "an inline script without the page's nonce: <script>",
      "the page registers a service worker",
    ]);
  });

  it("fails without the headers", () => {
    expect(checkPayPage({ html: page(), headers: {}, requireIntegrity: false })).toEqual([
      "the Content-Security-Policy has no nonce",
      "the Content-Security-Policy lacks frame-ancestors 'none'",
      'the Cross-Origin-Opener-Policy header isn\'t "same-origin"',
      'the Referrer-Policy header isn\'t "no-referrer"',
      'the Cache-Control header isn\'t "no-store"',
      'the X-Content-Type-Options header isn\'t "nosniff"',
    ]);
  });
});
