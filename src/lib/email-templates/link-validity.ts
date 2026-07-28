/**
 * How long an emailed auth link or code stays usable.
 *
 * This mirrors Supabase Auth's "Email OTP Expiration" setting (Authentication ->
 * Sign In / Providers -> Email). That setting is dashboard config and exists
 * nowhere in this repo, so the two can only be kept in step by hand: change one
 * and change the other. One setting governs every emailed link and code (sign-in,
 * confirmation, invite, recovery, reauthentication), which is why all the auth
 * templates read the number from here.
 *
 * Live value as of 2026-07-28: 3600 seconds, Supabase's default. Verified
 * against the live database rather than assumed: a confirmation link sent at
 * 11:06:25 UTC that day was still accepted at 11:29:41 UTC (`auth.users`,
 * `confirmed_at` - `confirmation_sent_at` = 23m15s), so the window is
 * demonstrably far longer than 10 minutes.
 */
export const AUTH_LINK_VALIDITY_MINUTES = 60;

/** Renders the window for email copy: "1 hour", "2 hours", "10 minutes". */
export function formatAuthLinkValidity(minutes: number = AUTH_LINK_VALIDITY_MINUTES): string {
  if (minutes % 60 !== 0) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  const hours = minutes / 60;
  return hours === 1 ? "1 hour" : `${hours} hours`;
}
