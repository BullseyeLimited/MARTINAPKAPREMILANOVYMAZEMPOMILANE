// AI WEEK Live - offline cache. Static shell + data cached; API always network.
const CACHE = "aiweek-v1";
const ASSETS = [
  "/",
  "/index.html",
  "/data/aiweek.json",
  "/fonts/hanken.woff2",
  "/fonts/newsreader.woff2",
  "/manifest.webmanifest"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET") return;                       // never touch POSTs
  if (url.pathname.startsWith("/api/")) return;           // AI calls: always live network

  if (url.pathname.startsWith("/data/")) {
    // fresh-first for agenda data, fall back to cache offline
    e.respondWith(
      fetch(req).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); return r; })
        .catch(() => caches.match(req))
    );
    return;
  }
  // cache-first for shell + fonts
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(r => {
      if (r.ok && (url.origin === location.origin)) {
        const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c));
      }
      return r;
    }).catch(() => caches.match("/index.html")))
  );
});
