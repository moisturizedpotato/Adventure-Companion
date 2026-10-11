const CACHE_NAME = "daymark-shell-v20";
const APP_SHELL = ["/", "/index.html", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const response = await fetch("/index.html");
    if (!response.ok) throw new Error(`Could not cache the app shell: ${response.status}`);
    const html = await response.text();
    const assets = Array.from(
      html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g),
      (match) => match[1],
    );
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll([...APP_SHELL, ...assets]);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/@vite/") ||
    url.pathname.startsWith("/@react-refresh") ||
    url.pathname.startsWith("/@id/") ||
    url.pathname.startsWith("/@fs/") ||
    url.pathname.startsWith("/src/") ||
    url.pathname.startsWith("/node_modules/")
  ) return;
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) => cache.match(event.request, { ignoreVary: true })).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      });
    }),
  );
});
