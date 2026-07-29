// Pure, server-import-free helpers for email verification.
//
// "Verified" means exactly one thing: someone opened a link we sent to that
// address. It is proof of mailbox control, and nothing more. It is not identity,
// not consent, and not deliverability forever.
//
// Two rules follow from that definition and are enforced here rather than left
// to each caller:
//
//   * A token only ever proves the address it was mailed to. If the account's
//     email changed after the token went out, redeeming it must do nothing.
//   * Verification is never asserted by hand. There is no "mark as verified"
//     path anywhere in the product, because a badge a manager can set is a badge
//     that means "a manager believed this" — which is the state the club is
//     already in, and the one that keeps failing.
//
// Keep this file free of side effects and of any server-only dependency (no
// supabase clients, no process.env reads) so it stays unit-testable, mirroring
// `validation.ts` and `club-users.ts`.
import { normalizeEmail } from "./validation";

/**
 * How long a verification link stays usable.
 *
 * Long on purpose. These links are not a security ceremony with a five-minute
 * window: the interest email's token also rides on the waiver prefill link, and
 * people come back to that email days or weeks later when they finally get
 * around to signing. An expiry short enough to be "safe" would mostly just
 * break the journey it exists to serve.
 */
export const VERIFICATION_TOKEN_TTL_DAYS = 180;

/** Why a token was minted. Recorded for support and analytics, never for auth. */
export const verificationPurposes = [
  /** The "fill in your waiver" link in an interest confirmation email. */
  "interest",
  /** The "confirm your email address" button in a waiver confirmation email. */
  "waiver",
  /** A manager pressed "resend verification" on the person's detail page. */
  "manager_resend",
  /** A member pressed "send verification email" on their own account page. */
  "self_resend",
  /** A manager corrected the address; this proves the NEW one. */
  "email_change",
] as const;
export type VerificationPurpose = (typeof verificationPurposes)[number];

/** ISO expiry for a token minted at `now`. */
export function verificationExpiry(now: Date = new Date()): string {
  return new Date(now.getTime() + VERIFICATION_TOKEN_TTL_DAYS * 86_400_000).toISOString();
}

/** The lifetime columns redemption checks before honouring a token. */
export type VerificationTokenLifetime = {
  expires_at: string;
  revoked_at?: string | null;
};

/** A token is honoured only while it is neither revoked nor past its expiry. */
export function isVerificationTokenLive(
  token: VerificationTokenLifetime,
  now: Date = new Date(),
): boolean {
  if (token.revoked_at) return false;
  const expires = new Date(token.expires_at).getTime();
  // An unparseable expiry is treated as expired: fail closed, never open.
  if (Number.isNaN(expires)) return false;
  return expires > now.getTime();
}

/**
 * Whether an address has been proven. The single source of truth is
 * `auth.users.email_confirmed_at` — there is deliberately no second copy on
 * `profiles` to drift from it.
 */
export function isEmailVerified(emailConfirmedAt: string | null | undefined): boolean {
  return Boolean(emailConfirmedAt);
}

/** The badge text shown to managers and members. Lowercase, like lifecycle pills. */
export type VerificationLabel = "verified" | "unverified";

export function emailVerificationLabel(
  emailConfirmedAt: string | null | undefined,
): VerificationLabel {
  return isEmailVerified(emailConfirmedAt) ? "verified" : "unverified";
}

/**
 * Whether a token may act on the account it resolved to.
 *
 * The token records the address it was mailed to; the account records the
 * address it has now. A manager correcting a typo mints a fresh token for the
 * new address, and every link sent to the old one becomes inert — otherwise an
 * old link would verify an address nobody ever proved.
 */
export function tokenProvesEmail(
  tokenEmail: string,
  accountEmail: string | null | undefined,
): boolean {
  if (!accountEmail) return false;
  const token = normalizeEmail(tokenEmail);
  if (!token) return false;
  return token === normalizeEmail(accountEmail);
}

/**
 * Where a verification link may land once it has done its work.
 *
 * An allowlist rather than a same-origin check: `next` arrives from a URL that
 * has been sitting in someone's inbox for months, and the set of places a
 * verification link should ever drop somebody is small and knowable.
 */
export const VERIFY_REDIRECT_PATHS = [
  "/",
  "/account",
  "/waiver",
  "/membership",
  "/thank-you",
] as const;

export const DEFAULT_VERIFY_REDIRECT = "/account";

/**
 * Resolve the `?next=` on a verification link to a safe internal path.
 *
 * Anything unrecognised falls back to the default rather than erroring, which
 * keeps the endpoint silent about what it did and did not accept. Absolute URLs
 * (`https://…`) and protocol-relative ones (`//evil.example`) are rejected by
 * the allowlist since neither can ever equal a listed path.
 */
export function verifyRedirectPath(next: string | null | undefined): string {
  if (!next) return DEFAULT_VERIFY_REDIRECT;
  const candidate = next.trim();
  const match = (VERIFY_REDIRECT_PATHS as readonly string[]).includes(candidate);
  return match ? candidate : DEFAULT_VERIFY_REDIRECT;
}

/** The link that goes in an email: `<site>/api/verify-email/<token>?next=<path>`. */
export function buildVerifyUrl(opts: { siteUrl: string; token: string; next?: string }): string {
  const base = opts.siteUrl.replace(/\/+$/, "");
  const next = verifyRedirectPath(opts.next);
  const search = new URLSearchParams({ next });
  return `${base}/api/verify-email/${encodeURIComponent(opts.token)}?${search.toString()}`;
}
