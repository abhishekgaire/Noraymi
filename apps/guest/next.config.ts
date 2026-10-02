import path from "node:path";
import type { NextConfig } from "next";

/** Where the guest pages' /v1 calls go: the API, behind the same origin (M2-25). */
const api = (process.env["API_URL"] ?? "http://localhost:3000").replace(/\/+$/, "");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // A self-contained server for the container image (apps/guest/Dockerfile).
  output: "standalone",
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  // Subresource integrity on our own scripts, for the payment page (M4-15; Security 1). Build-time only.
  experimental: { sri: { algorithm: "sha256" } },
  rewrites() {
    return [{ source: "/v1/:path*", destination: `${api}/v1/:path*` }];
  },
  headers() {
    // Token pages never leak their token in a Referer and are never cached.
    return Promise.resolve([
      {
        source: "/w/:token",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
      // The host's Room code link carries its token in the path (M3-08); the room page is behind a cookie.
      {
        source: "/r/:token",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
      // The receipt link (M4-19): its token is in the path.
      {
        source: "/receipt/:token",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
      // The guest's booking link (M4-16): its token is in the path.
      {
        source: "/b/:token",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
      {
        source: "/room",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ]);
  },
};

export default nextConfig;
