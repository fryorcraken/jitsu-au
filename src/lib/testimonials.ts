// Pure, side-effect-free helpers for the Testimonials strip. Kept out of the
// component file so the placeholder guard is independently unit-testable.

// The club's Google reviews (source of truth for the featured quotes).
export const GOOGLE_REVIEWS_URL = "https://maps.app.goo.gl/VhonWy3FDoyBpax59";

// Any string still carrying this marker is placeholder content, not a real review.
export const PLACEHOLDER_MARK = "[PLACEHOLDER";

export type Quote = { name: string; text: string };

/**
 * True while any supplied content still carries the placeholder marker. The
 * warning UI is driven off this, so it can never be out of sync with the data:
 * real reviews clear it automatically, placeholder text can't ship without it.
 */
export function hasPlaceholderContent(items: Quote[], ...extra: string[]): boolean {
  return [...items.flatMap((q) => [q.name, q.text]), ...extra].some((s) =>
    s.includes(PLACEHOLDER_MARK),
  );
}
