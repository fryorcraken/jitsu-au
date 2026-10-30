// Business rules for the site-wide top banner. It used to sell the "2 free
// classes" offer; while the club trains at a temporary location it says free
// trials are paused and asks people to register their interest instead.
// Kept free of React/router/DOM imports so the rules stay unit-testable.

/**
 * localStorage key holding the visitor's dismissal of the banner.
 *
 * Versioned by message: a visitor who dismissed the old free-trial offer never
 * agreed to miss the news that trials are paused, so a new message gets a new
 * key and is shown once to everybody. The old `uts-offer-banner-dismissed`
 * value is simply never read again.
 */
export const OFFER_BANNER_STORAGE_KEY = "uts-offer-banner-dismissed-trials-paused";

// Pages already inside the register-interest / waiver funnel: the nudge would
// be redundant there, so the banner is suppressed.
const HIDDEN_PATH_PREFIXES = ["/register-interest", "/waiver"] as const;

/** Whether the banner should be hidden on the given route path. */
export function isOfferBannerHiddenPath(pathname: string): boolean {
  return HIDDEN_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/** Whether the visitor previously dismissed the banner (persisted). */
export function isOfferBannerDismissed(
  storage: Pick<Storage, "getItem"> | null | undefined,
): boolean {
  try {
    return storage?.getItem(OFFER_BANNER_STORAGE_KEY) === "1";
  } catch {
    // Storage can throw (private mode, disabled cookies) — treat as not dismissed.
    return false;
  }
}

/** Persist the visitor's dismissal so the banner stays hidden across visits. */
export function persistOfferBannerDismissed(
  storage: Pick<Storage, "setItem"> | null | undefined,
): void {
  try {
    storage?.setItem(OFFER_BANNER_STORAGE_KEY, "1");
  } catch {
    // Ignore storage failures — dismissal simply won't persist this session.
  }
}
