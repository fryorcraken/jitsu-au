/*
 * UTS Jitsu service worker.
 *
 * Deliberately small and hand-written: the site is server-rendered and most of
 * what people come for (their membership, the calendar, a waiver) is live data
 * that must never be served from a stale cache. So this worker does two things
 * only, which is also what makes the app installable:
 *
 *   1. Pages always come from the network. If the network is gone, you get the
 *      offline card instead of the browser's dinosaur.
 *   2. Static assets (scripts, styles, fonts, images) are served from the cache
 *      and refreshed in the background, so a launch on a bad connection still
 *      paints.
 *
 * Nothing else is intercepted. Supabase calls and server functions are `fetch`
 * requests with an empty `destination`, so they fall through to the network
 * untouched and no signed-in data ever lands in a cache.
 *
 * Bump CACHE_VERSION to evict everything on the next deploy.
 */

const CACHE_VERSION = "v1";
const ASSET_CACHE = `uts-jitsu-assets-${CACHE_VERSION}`;
const SHELL_CACHE = `uts-jitsu-shell-${CACHE_VERSION}`;
const CURRENT_CACHES = [ASSET_CACHE, SHELL_CACHE];

const OFFLINE_URL = "/offline.html";
const SHELL_ASSETS = [OFFLINE_URL, "/manifest.webmanifest", "/icons/icon-192.png"];

// Everything a page pulls in that is safe to reuse. `destination` is set by the
// browser from the element that asked for it, so this cannot accidentally match
// an API call.
const CACHEABLE_DESTINATIONS = new Set(["style", "script", "font", "image"]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => !CURRENT_CACHES.includes(key)).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }

  if (CACHEABLE_DESTINATIONS.has(request.destination)) {
    event.respondWith(handleAsset(request));
  }
});

/** Pages: network only, with the offline card as the last resort. */
async function handleNavigation(request) {
  try {
    return await fetch(request);
  } catch (error) {
    const offline = await caches.match(OFFLINE_URL, { cacheName: SHELL_CACHE });
    if (offline) return offline;
    throw error;
  }
}

/** Assets: serve the cached copy immediately, refresh it in the background. */
async function handleAsset(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);

  const fromNetwork = fetch(request)
    .then((response) => {
      // `basic` means same-origin and readable. Opaque and error responses are
      // not worth keeping and would poison the cache.
      if (response.ok && response.type === "basic") {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(async (error) => {
      // Fall back across every cache, not just the runtime one: the offline
      // card's logo is precached in the shell, and it is needed at exactly the
      // moment the network is gone.
      const fallback = cached ?? (await caches.match(request));
      if (fallback) return fallback;
      throw error;
    });

  return cached ?? fromNetwork;
}
