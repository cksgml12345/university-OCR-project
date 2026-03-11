const CACHE_VERSION = "v1";
const APP_SHELL_CACHE = `book-ocr-shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = `book-ocr-runtime-${CACHE_VERSION}`;

const APP_SHELL_URLS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/favicon.ico",
  "/logo192.png",
  "/logo512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(APP_SHELL_CACHE)
      .then((cache) => cache.addAll(APP_SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (![APP_SHELL_CACHE, RUNTIME_CACHE].includes(key)) {
            return caches.delete(key);
          }
          return Promise.resolve();
        })
      )
    )
  );
  self.clients.claim();
});

const isStaticAsset = (requestUrl) => requestUrl.pathname.startsWith("/static/");
const isApiRequest = (requestUrl) =>
  requestUrl.pathname.startsWith("/books") ||
  requestUrl.pathname.startsWith("/process") ||
  requestUrl.pathname.startsWith("/uploads") ||
  requestUrl.pathname.startsWith("/health");

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") {
    return;
  }

  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  if (isStaticAsset(requestUrl)) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) {
          return cached;
        }
        const response = await fetch(request);
        cache.put(request, response.clone());
        return response;
      })
    );
    return;
  }

  if (isApiRequest(requestUrl)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) {
            return cached;
          }
          return new Response(JSON.stringify({ message: "오프라인 상태입니다." }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          });
        })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request))
  );
});
