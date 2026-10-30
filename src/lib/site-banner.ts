// Rules for the site banner across the top of every public page, kept free of
// React/router/DOM imports so they stay unit-testable. What the banner says is
// a manager's setting (`docs/site-banner.md`); this decides when a visitor sees
// it, and what its link does.
import { SITE_ORIGIN } from "@/lib/site-origin";
import type { SiteBanner } from "@/lib/validation";

/**
 * Cookie holding the banner a visitor closed.
 *
 * A cookie rather than localStorage because the server draws the banner into
 * the page: it has to know, before it sends a byte, whether this visitor closed
 * it. With localStorage it could only find out after the page loaded, so the
 * banner would either arrive late and push the page down, or flash up on every
 * page for somebody who already closed it.
 *
 * The value is that banner's fingerprint, not a flag. Closing one notice is not
 * agreeing to miss the next, so a new message (or a new link) has a different
 * fingerprint and is shown again, while the same notice turned off and back on
 * stays closed for whoever already closed it. Nothing secret, so readable by
 * the page.
 */
export const SITE_BANNER_COOKIE = "uts_site_banner_dismissed";

/** A year: long enough to outlast any one notice. */
const DISMISS_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/**
 * A short, stable id for what a banner says. FNV-1a over its text: nothing
 * secret, just small enough to store and identical for identical banners.
 */
export function siteBannerFingerprint(
  banner: Pick<SiteBanner, "message" | "link_label" | "link_href">,
): string {
  const text = JSON.stringify([banner.message, banner.link_label, banner.link_href]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * The fingerprint of the banner this visitor closed, read from a `Cookie`
 * header (server) or `document.cookie` (browser), which share a format.
 */
export function readDismissedSiteBanner(cookies: string | null | undefined): string | null {
  for (const part of (cookies ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === SITE_BANNER_COOKIE) return value.join("=") || null;
  }
  return null;
}

/** The `document.cookie` assignment that remembers closing this banner. */
export function dismissSiteBannerCookie(fingerprint: string, secure: boolean): string {
  return [
    `${SITE_BANNER_COOKIE}=${fingerprint}`,
    "Path=/",
    `Max-Age=${DISMISS_MAX_AGE_SECONDS}`,
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/**
 * The link as an address on this site (`/faq#trial`), or null when it goes
 * somewhere else. A full address to this site (`https://utsjitsu.com.au/faq`)
 * counts as this site: it is the same page, and should behave like it.
 */
export function siteBannerLocalHref(href: string): string | null {
  if (href.startsWith("/")) return href;
  if (href === SITE_ORIGIN || href.startsWith(`${SITE_ORIGIN}/`)) {
    return href.slice(SITE_ORIGIN.length) || "/";
  }
  return null;
}

/**
 * Pages where the banner's message shows but its link does not: the forms. The
 * whole line is a tap target, and on these a stray tap would carry somebody
 * away from a form they are partway through (the waiver holds health answers
 * and a signature). The old free-trial offer was hidden on the waiver and the
 * register page for the same reason; a notice is still worth reading there, a
 * link is not.
 */
const NO_LINK_PATH_PREFIXES = ["/waiver", "/register-interest", "/contact"] as const;

function trimSlash(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

/**
 * Whether the banner's link should be dropped on this page: on a form (above),
 * or where the link points at the page the visitor is already on. A link to a
 * section of this page (`/faq#trial` on `/faq`) is kept, because following it
 * is useful there. The message shows either way.
 */
export function shouldDropSiteBannerLink(href: string, pathname: string): boolean {
  const here = trimSlash(pathname);
  if (NO_LINK_PATH_PREFIXES.some((p) => here === p || here.startsWith(`${p}/`))) return true;
  const local = siteBannerLocalHref(href);
  if (!local || local.includes("#")) return false;
  return trimSlash(local.split("?")[0]) === here;
}
