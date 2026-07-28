// Client-side bookkeeping for short-lived Supabase signed URLs.
//
// `getWaiverPdfUrl` signs a waiver PDF for one hour. A screen that embeds the
// PDF caches that URL, but the cache has to expire *before* the signature does:
// a collapsed panel unmounts its iframe, so reopening it later remounts on
// whatever URL the cache still holds, and an expired one renders the storage
// error instead of the waiver. Pure and side-effect free so the rule is
// unit-testable away from the component.

/** Re-sign this far before the server's 1-hour signature actually expires. */
export const SIGNED_URL_TTL_MS = 50 * 60 * 1000;

/** One cache slot: a signed URL, or the error that stopped us getting one. */
export type SignedUrlEntry = { url?: string; at: number; error?: string };

/** True while a cached URL is young enough to hand to the browser. */
export function isSignedUrlFresh(entry: SignedUrlEntry | undefined, now: number): boolean {
  if (!entry?.url) return false;
  return now - entry.at < SIGNED_URL_TTL_MS;
}

/**
 * Whether to go and sign a URL for this slot. Nothing cached or a stale URL
 * means yes; a fresh URL means no. A recorded error also means no: it stays
 * failed until the person retries (which clears the slot), so an effect that
 * re-runs on every cache write can't spin on a failing request.
 */
export function shouldFetchSignedUrl(entry: SignedUrlEntry | undefined, now: number): boolean {
  if (isSignedUrlFresh(entry, now)) return false;
  return !entry?.error;
}
