/* The staff app's service worker (M1-22).
   It caches the app shell only: the page, its scripts, styles, icons and the
   manifest. API calls under /v1 are never looked at, never cached, so every
   number on screen comes from the server. A push shows a notification; a tap
   opens the path the push names. */
const SHELL_CACHE = "west4-staff-shell-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

/** Only the app shell on this origin; never the API, never another site. */
function isShellRequest(request) {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith("/v1/")) return false;
  if (request.mode === "navigate") return true;
  return ["script", "style", "image", "font", "manifest"].includes(request.destination);
}

self.addEventListener("fetch", (event) => {
  if (!isShellRequest(event.request)) return;
  event.respondWith(
    caches.open(SHELL_CACHE).then(async (cache) => {
      try {
        const fresh = await fetch(event.request);
        if (fresh.ok) await cache.put(event.request, fresh.clone());
        return fresh;
      } catch (error) {
        const cached = await cache.match(event.request, {
          ignoreSearch: event.request.mode === "navigate",
        });
        if (cached) return cached;
        if (event.request.mode === "navigate") {
          const root = await cache.match("/");
          if (root) return root;
        }
        throw error;
      }
    }),
  );
});

self.addEventListener("push", (event) => {
  let data = { title: "", body: "", url: "/", tag: undefined };
  try {
    data = { ...data, ...event.data.json() };
  } catch {
    data.body = event.data ? event.data.text() : "";
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: data.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(
    (event.notification.data && event.notification.data.url) || "/",
    self.location.origin,
  ).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const open = clients.find((c) => "focus" in c);
      if (open) return open.navigate(url).then((c) => (c || open).focus());
      return self.clients.openWindow(url);
    }),
  );
});
