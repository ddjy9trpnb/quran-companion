const CACHE = "quran-companion-local-v2";
const ROOT = new URL(self.registration.scope);
const SHELL = [ROOT.href, new URL("manifest.webmanifest", ROOT).href, new URL("icon.svg", ROOT).href];
self.addEventListener("install", (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL))));
self.addEventListener("activate", (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))));
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || !url.href.startsWith(ROOT.href)) return;
  event.respondWith(fetch(event.request).then(async (response) => {
    if (event.request.method === "GET" && response.ok) await caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
    return response;
  }).catch(() => caches.match(event.request)));
});
