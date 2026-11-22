// Huginn's service worker: shows phone alerts and opens the right sheet when one is tapped.
// It caches nothing; Huginn is always live.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { title: "Huginn", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(m.title || "Huginn", {
    body: m.body || "", tag: m.tag || "huginn", renotify: true,
    icon: "icons/huginn-192.png", badge: "icons/huginn-192.png", data: { url: m.url || "./" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) if (w.url.startsWith(self.registration.scope)) { await w.focus(); w.postMessage({ open: new URL(url).hash.slice(1) }); return; }
    await self.clients.openWindow(url);
  })());
});
