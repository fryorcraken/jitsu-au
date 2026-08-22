/**
 * The response headers the site sets on everything it serves.
 *
 * This module exists because of one header: `Referer`. Three routes carry a
 * credential in the URL **path**, because the software that opens them has
 * nowhere else to put it:
 *
 *   /api/calendar/<token>      an ICS feed a calendar app polls for months
 *   /api/verify-email/<token>  an email link, single use and time bound
 *   /email-settings/<token>    the settings panel at the foot of every email
 *
 * A calendar client and a mail client cannot send an Authorization header or a
 * POST body, so for those three the token stays in the path. What is avoidable
 * is the browser then handing that URL to somebody else. With no
 * `Referrer-Policy` the browser falls back to its own default, which still
 * sends the full URL - token and all - on every same-origin request the page
 * makes, and older or differently configured browsers send it cross-origin
 * too. `/email-settings/<token>` is a full page with a footer full of outbound
 * links, so this is not theoretical.
 *
 * So the site sends `strict-origin-when-cross-origin` everywhere, and the three
 * token paths send `no-referrer`, which is the only value that keeps the path
 * out of a same-origin `Referer` as well.
 *
 * The token paths also get `Cache-Control: no-store` unless the route set its
 * own, which keeps a URL containing a credential out of shared and on-disk
 * caches. The calendar feed sets `private, max-age=300` on purpose (a calendar
 * client polls it), so it keeps that.
 *
 * `public/_headers` states the same rules, referrer policy and no-store both,
 * for anything the platform serves without going through this middleware.
 * `security-headers.test.ts` fails if the two drift apart. The no-store matters
 * more there than here: that file covers the case where this middleware never
 * ran, so nothing else would keep a URL with a credential in it out of a cache.
 */

/** What everything gets: the origin cross-site, the full URL same-site. */
export const DEFAULT_REFERRER_POLICY = "strict-origin-when-cross-origin";

/** What a URL with a credential in it gets: nothing, to anyone. */
export const TOKEN_PATH_REFERRER_POLICY = "no-referrer";

/**
 * Route prefixes whose path segment after them is a credential.
 *
 * Adding a route that takes a token in its path? Add its prefix here and to
 * `public/_headers`.
 */
export const TOKEN_PATH_PREFIXES = [
  "/api/calendar/",
  "/api/verify-email/",
  "/email-settings/",
] as const;

/** True when this path carries a token a `Referer` header must never leak. */
export function carriesTokenInPath(pathname: string): boolean {
  return TOKEN_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** The `Referrer-Policy` value for a path. */
export function referrerPolicyFor(pathname: string): string {
  return carriesTokenInPath(pathname) ? TOKEN_PATH_REFERRER_POLICY : DEFAULT_REFERRER_POLICY;
}

function setHeaders(headers: Headers, pathname: string): void {
  headers.set("referrer-policy", referrerPolicyFor(pathname));
  // A route that chose its own caching keeps it. See the calendar feed.
  if (carriesTokenInPath(pathname) && !headers.has("cache-control")) {
    headers.set("cache-control", "no-store");
  }
}

/**
 * The same response, with the security headers on it.
 *
 * Mutates in place where it can. That matters for the SSR response, whose body
 * is a live stream bound to the request for cleanup: re-wrapping it would cut
 * that binding. Only the responses that cannot be mutated get rebuilt.
 */
export function applySecurityHeaders(response: Response, pathname: string): Response {
  try {
    setHeaders(response.headers, pathname);
    return response;
  } catch (error) {
    // `Response.redirect()` and `Response.error()` hand back headers with an
    // immutable guard, so the only way to add to one is to build a new one.
    //
    // Only for that. A bare `catch` here sent EVERY failure down the rebuild
    // path, the SSR response included, and that response's body is a live
    // stream bound to the request for cleanup: re-wrapping it cuts the binding,
    // and the symptom is a truncated or leaked response rather than an error
    // anybody sees. The comment above already says this response must be
    // mutated in place, so the control flow should enforce it rather than rely
    // on nothing else ever throwing.
    if (!(error instanceof TypeError)) throw error;
    const headers = new Headers(response.headers);
    setHeaders(headers, pathname);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}
