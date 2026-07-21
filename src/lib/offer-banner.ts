// Business rules for the site-wide "2 free classes" offer banner.
// Kept free of React/router/DOM imports so the rules stay unit-testable.

/** localStorage key holding the visitor's dismissal of the offer banner. */
export const OFFER_BANNER_STORAGE_KEY = "uts-offer-banner-dismissed";

// Pages already inside the free-trial / waiver funnel: the offer nudge would be
// redundant there, so the banner is suppressed.
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
