// public/sw.js
const CACHE = "bt-v6";

// קבצים שכדאי לקבע במטמון (ללא dashboard.js)
const PRECACHE = [
  "/",
  "/style.css",
  "/push.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // לא ליירט את dashboard.js ואת socket.io
  if (url.pathname === "/dashboard.js" || url.pathname.startsWith("/socket.io/")) {
    return; // ברירת מחדל: רשת
  }

  // ניווטי דפים -> רשת תחילה
  if (event.request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(event.request);
        return fresh;
      } catch {
        const cache = await caches.open(CACHE);
        const fallback = await cache.match("/");
        return fallback || Response.error();
      }
    })());
    return;
  }

  // סטטיים אחרים -> cache תחילה עם נפילה לרשת
  if (PRECACHE.includes(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(event.request);
      if (cached) return cached;
      try {
        const fresh = await fetch(event.request);
        cache.put(event.request, fresh.clone());
        return fresh;
      } catch {
        return Response.error();
      }
    })());
  }
});
