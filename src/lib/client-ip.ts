/**
 * Best-effort real client IP from the proxy headers.
 *
 * Kept on a waiver and on a code-of-conduct acceptance as part of the forensic
 * record of who signed. Pure, so it is testable without a request context: the
 * caller hands over a header getter.
 */
export function clientIp(getHeader: (name: string) => string | undefined): string | null {
  const fwd = getHeader("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return getHeader("cf-connecting-ip") || getHeader("x-real-ip") || null;
}
