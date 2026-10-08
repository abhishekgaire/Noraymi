import { makeClientReporter, reportUncaught } from "@west4/shared";

/**
 * The staff app's errors (M8-16): scrubbed of personal data here and again by the API, sent
 * through POST /v1/public/telemetry. Inside the desktop app it reports as "desktop".
 */
export const reporter = makeClientReporter({
  service: typeof window !== "undefined" && window.west4 ? "desktop" : "staff",
  post: (body) =>
    fetch("/v1/public/telemetry", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    }),
});

/** Reports the window's uncaught errors and unhandled rejections from the first render on. */
export function installErrorReporting(): void {
  if (typeof window === "undefined") return;
  reportUncaught(window, reporter, () => window.location.pathname);
}
