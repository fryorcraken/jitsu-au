/**
 * Service worker registration.
 *
 * Kept out of `pwa.ts` so that module stays free of browser globals and easy to
 * unit test. The worker itself is `public/sw.js`, hand-written and served as-is.
 */

const SERVICE_WORKER_URL = "/sw.js";

/**
 * Register the service worker in production, and make sure a stale one is not
 * left running anywhere else.
 *
 * Registration waits for `load` so it never competes with the first render.
 * In dev it actively unregisters instead: a worker picked up from a production
 * visit would sit in front of the Vite dev server and serve yesterday's assets,
 * which is a genuinely confusing hour to lose.
 */
export function setUpServiceWorker(): () => void {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return () => {};

  if (!import.meta.env.PROD) {
    void navigator.serviceWorker
      .getRegistrations()
      .then((registrations) => registrations.forEach((registration) => registration.unregister()))
      .catch(() => {});
    return () => {};
  }

  const register = () => {
    void navigator.serviceWorker.register(SERVICE_WORKER_URL).catch((error) => {
      // A failed registration costs offline support and nothing else, so it is
      // never worth surfacing to the user.
      console.warn("Service worker registration failed", error);
    });
  };

  if (document.readyState === "complete") {
    register();
    return () => {};
  }

  window.addEventListener("load", register, { once: true });
  return () => window.removeEventListener("load", register);
}
