import path from "node:path";
import type { NextConfig } from "next";

/** Where the guest pages' /v1 calls go: the API, behind the same origin (M2-25). */
const api = (process.env["API_URL"] ?? "http://localhost:3000").replace(/\/+$/, "");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // A self-contained server for the container image (apps/guest/Dockerfile).
  output: "standalone",
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
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
