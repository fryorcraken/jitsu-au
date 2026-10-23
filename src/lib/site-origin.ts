// The site's address, and the hosts that serve it.
//
// Everything the app links to from outside a browser tab (canonicals, the
// sitemap, every link in every email, the calendar feed) is built from
// SITE_ORIGIN, so moving the site is a change here rather than a hunt. This
// module imports nothing on purpose: server-only email senders, the calendar
// route and client components all read it, and none of them should pay for
// `seo.ts`'s page list and image assets to do so.

/** Canonical origin. Every `rel="canonical"` on the site points here. */
export const SITE_ORIGIN = "https://utsjitsu.com.au";

/** The origin without its scheme, for copy that names the address to a person. */
export const SITE_HOST = new URL(SITE_ORIGIN).host;

/**
 * Hosts that serve the real site. Anything else (a Lovable preview, a
 * Cloudflare *.workers.dev URL, a branch deploy) is the same content on a
 * different hostname, which is exactly the duplicate-content case search
 * engines penalise. Those hosts get a "stay out" robots.txt instead.
 *
 * The club's other domains are listed here on purpose, and are NOT blocked.
 * They serve the same site, and every page canonicals to utsjitsu.com.au, so
 * letting crawlers in is what consolidates the ranking signal there. Blocking
 * them would stop a crawler ever reading that canonical and leave bare,
 * contentless URLs eligible for the index instead.
 *
 * This list is the site's off switch: a host that is missing here is told to
 * stay out entirely. `www.` variants are included whether or not they are
 * wired up today, because listing a host that never receives a request costs
 * nothing, while omitting one that does costs the site its search traffic.
 */
export const PRODUCTION_HOSTS = [
  "utsjitsu.com.au",
  "www.utsjitsu.com.au",
  "jitsu.au",
  "www.jitsu.au",
  "sydneyjitsu.com.au",
  "www.sydneyjitsu.com.au",
];

/** True when the request arrived on a hostname that serves the real site. */
export function isProductionHost(host: string | null | undefined): boolean {
  if (!host) return false;
  // A Host header may carry a port; the rules do not depend on it.
  const name = host.trim().toLowerCase().split(":")[0];
  return PRODUCTION_HOSTS.includes(name);
}

/**
 * The origin for a link somebody will use outside this browser tab (a
 * calendar subscription, the manager agent's endpoint), given the origin the
 * request came in on.
 *
 * On any of the club's own hosts that is SITE_ORIGIN, whichever one the
 * person happens to be browsing: the others only redirect to it or duplicate
 * it, and these links carry a token that a redirect to another host drops.
 * Anywhere else (a Lovable preview, a branch deploy, localhost) it is that
 * origin, so a test stack hands out links to itself rather than to the club.
 */
export function linkOrigin(requestOrigin: string | null | undefined): string {
  if (!requestOrigin) return SITE_ORIGIN;
  let url: URL;
  try {
    url = new URL(requestOrigin);
  } catch {
    return SITE_ORIGIN;
  }
  return isProductionHost(url.host) ? SITE_ORIGIN : url.origin;
}
