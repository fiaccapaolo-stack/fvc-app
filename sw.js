const CACHE_NAME = "signalpoint-v2";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Strategia:
// - index.html e le chiamate /api/*: sempre network-first, cosi' i contenuti
//   modificati dal pannello admin (nome, indirizzo, catalogo, offerte...)
//   appaiono subito, senza aspettare la cache. Si usa la cache solo se il
//   telefono e' offline.
// - il resto (icone, manifest): cache-first, cosi' l'app si apre veloce
//   anche offline.
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  const isNavigate = request.mode === "navigate";
  const isApi = url.pathname.startsWith("/api/");

  if (isNavigate || isApi) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (isNavigate) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => (isNavigate ? caches.match("./index.html") : caches.match(request)))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      return (
        cached ||
        fetch(request).then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
      );
    })
  );
});

// Placeholder per push notifications future: quando collegherai un backend
// con VAPID keys, gestirai qui l'evento "push" per mostrare le notifiche
// anche ad app chiusa.
self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || "Fvc Project";
  const options = {
    body: data.body || "Nuova offerta disponibile",
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    data: { url: "./index.html#offerte" }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Tap su una notifica: apre (o porta in primo piano) l'app sulla sezione offerte
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "./index.html";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientsArr) => {
      const existing = clientsArr.find((c) => "focus" in c);
      if (existing) {
        existing.navigate(targetUrl);
        return existing.focus();
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
