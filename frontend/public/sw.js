/**
 * Service worker for the installed app.
 *
 * Deliberately minimal. The dashboard's whole job is showing live state, so
 * nothing under /api is ever cached - a stale player count or a replayed
 * console line would be worse than an error. What is cached is the app shell,
 * so opening the icon with no connection gives the dashboard's own "cannot
 * reach the server" instead of the browser's error page.
 */

/**
 * Bumped when a cached asset changes name-for-name. Hashed bundles look after
 * themselves, but the icons and the logo do not carry a hash, so replacing the
 * mark without this leaves every installed copy showing the old one - the
 * activate handler below deletes every cache that is not this one.
 */
const CACHE = "mc-dashboard-shell-v2";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add("/index.html")));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api")) return;

  // Navigations go to the network first: a cached index.html would keep
  // pointing at the previous build's hashed bundle after a deploy.
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/index.html")));
    return;
  }

  // Build assets carry a content hash in their name, so a cached copy can
  // never be the wrong version of itself.
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
    )
  );
});
