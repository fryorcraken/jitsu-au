// Rules for the site banner across the top of every public page, kept free of
// React/router/DOM imports so they stay unit-testable. What the banner says is
// a manager's setting (`docs/site-banner.md`); this decides when a visitor sees
// it.
import type { SiteBanner } from "@/lib/validation";

/** The react-query key the banner is cached under; a manager's save refreshes it. */
export const SITE_BANNER_QUERY_KEY = ["site-banner"] as const;

/**
 * localStorage key holding the banner a visitor closed.
 *
 * The value is that banner's fingerprint, not a flag. Closing one notice is not
 * agreeing to miss the next, so a new message (or a new link) has a different
 * fingerprint and is shown again, while the same notice turned off and back on
 * stays closed for whoever already closed it.
 */
export const SITE_BANNER_STORAGE_KEY = "uts-site-banner-dismissed";

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

/** The fingerprint of the banner this visitor closed, if any. */
export function readDismissedSiteBanner(
  storage: Pick<Storage, "getItem"> | null | undefined,
): string | null {
  try {
    return storage?.getItem(SITE_BANNER_STORAGE_KEY) ?? null;
  } catch {
    // Storage can throw (private mode, disabled cookies): treat as not dismissed.
    return null;
  }
}

/** Remember that this visitor closed the banner with this fingerprint. */
export function persistDismissedSiteBanner(
  storage: Pick<Storage, "setItem"> | null | undefined,
  fingerprint: string,
): void {
  try {
    storage?.setItem(SITE_BANNER_STORAGE_KEY, fingerprint);
  } catch {
    // Ignore storage failures: the dismissal simply won't outlive this page.
  }
}

/**
 * Pages where the banner's message shows but its link does not. The whole line
 * is a tap target, and on these a stray tap would carry somebody away from a
 * form they are partway through (the waiver holds health answers and a
 * signature). The old free-trial offer was hidden on the waiver for the same
 * reason; a notice is still worth reading there, a link is not.
 */
const NO_LINK_PATH_PREFIXES = ["/waiver"] as const;

/**
 * Whether the banner's link should be dropped on this page: on a form-filling
 * page (above), or where the link points at the page the visitor is already
 * on. The message still shows either way (on the register page, "free trials
 * are paused" is the most useful place for it).
 */
export function shouldDropSiteBannerLink(href: string, pathname: string): boolean {
  const here = pathname.replace(/\/+$/, "") || "/";
  if (NO_LINK_PATH_PREFIXES.some((p) => here === p || here.startsWith(`${p}/`))) return true;
  if (!href.startsWith("/")) return false;
  const path = href.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  return path === here;
}
