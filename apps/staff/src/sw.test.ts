import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

/**
 * The service worker caches the app shell only, never an API response: it is
 * loaded into a fake worker scope and handed requests to see which ones it
 * answers from its cache and which it leaves alone.
 */
type Handler = (event: unknown) => void;

function load() {
  const listeners = new Map<string, Handler>();
  const self = {
    location: { origin: "https://staff.west4.local" },
    addEventListener: (type: string, fn: Handler) => listeners.set(type, fn),
    skipWaiting: () => {},
    clients: { claim: async () => {} },
    registration: { showNotification: async () => {} },
  };
  const source = readFileSync(resolve(__dirname, "../public/sw.js"), "utf8");
  const cache = { put: async () => {}, match: async () => undefined };
  const caches = { open: async () => cache, keys: async () => [], delete: async () => true };
  runInNewContext(source, {
    self,
    caches,
    URL,
    fetch: () => Promise.reject(new Error("offline")),
  });
  return listeners;
}

function fetchEvent(
  url: string,
  extra: { method?: string; mode?: string; destination?: string } = {},
) {
  let handled = false;
  const event = {
    request: {
      url,
      method: extra.method ?? "GET",
      mode: extra.mode ?? "no-cors",
      destination: extra.destination ?? "",
    },
    respondWith: (answer: Promise<unknown>) => {
      handled = true;
      answer.catch(() => {});
    },
  };
  return { event, handled: () => handled };
}

describe("the staff service worker", () => {
  const listeners = load();
  const fetch = listeners.get("fetch")!;

  it("never touches an API call", () => {
    for (const url of [
      "https://staff.west4.local/v1/auth/me",
      "https://staff.west4.local/v1/venues/1/events",
      "https://staff.west4.local/v1/push/vapid-key",
    ]) {
      const { event, handled } = fetchEvent(url, { mode: "cors" });
      fetch(event);
      expect(handled(), url).toBe(false);
    }
    const post = fetchEvent("https://staff.west4.local/", { method: "POST", mode: "navigate" });
    fetch(post.event);
    expect(post.handled()).toBe(false);
  });

  it("serves the shell: pages, scripts, styles, icons and the manifest on this origin", () => {
    for (const [url, extra] of [
      ["https://staff.west4.local/tonight", { mode: "navigate" }],
      ["https://staff.west4.local/assets/index-abc.js", { destination: "script" }],
      ["https://staff.west4.local/assets/index-abc.css", { destination: "style" }],
      ["https://staff.west4.local/icon-192.png", { destination: "image" }],
      ["https://staff.west4.local/manifest.webmanifest", { destination: "manifest" }],
    ] as const) {
      const { event, handled } = fetchEvent(url, extra);
      fetch(event);
      expect(handled(), url).toBe(true);
    }
    const other = fetchEvent("https://fonts.example.com/a.woff2", { destination: "font" });
    fetch(other.event);
    expect(other.handled()).toBe(false);
  });

  it("shows a push as a notification and opens its url on tap", () => {
    expect(listeners.has("push")).toBe(true);
    expect(listeners.has("notificationclick")).toBe(true);
  });
});
