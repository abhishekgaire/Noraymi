"use client";

import { makeClientReporter } from "@west4/shared";

/**
 * The guest pages' errors and their own spans (M8-16), scrubbed here and again by the API, sent
 * through POST /v1/public/telemetry. The page holds no vendor key.
 */
export const reporter = makeClientReporter({
  service: "guest",
  post: (body) =>
    fetch("/v1/public/telemetry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    }),
});
