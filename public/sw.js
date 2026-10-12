/* ClankerDesk service worker.
   Two jobs:
   1. Make the page installable as an app (ChromeOS launcher / shelf, taskbar):
      Chrome requires a service worker for the install prompt.
   2. Keep a cached copy of the shell so a flaky connection still opens the
      page. Everything is revalidated on every load (network-first), and the
      live stuff -- download zips, API, websocket -- is never cached, so a
      fresh deploy is always what runs. */

const CACHE = "clankerdesk-shell-v1";
const CORE = ["/", "/app.js", "/theme.css", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).catch(() => {}));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // fonts etc: straight to network
  // Never cache the things that must stay live:
  if (url.pathname.startsWith("/download/") ||
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/ws")) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((r) => r || (req.mode === "navigate" ? caches.match("/") : null) || Response.error())
      )
  );
});
