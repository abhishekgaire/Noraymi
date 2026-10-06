/*
 * The singer's queue page's service worker (M6-21): it shows the singer alerts the
 * server pushes ("2 singers before you", "You're up next at the bar · come to the
 * stage") while the page is closed, and a tap opens the queue page. It caches
 * nothing; it's registered only on the queue page, scoped to it.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

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
      const open = clients.find((c) => c.url === url);
      return open ? open.focus() : self.clients.openWindow(url);
    }),
  );
});
