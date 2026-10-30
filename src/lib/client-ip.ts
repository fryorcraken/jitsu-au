/**
 * The visitor's IP address, as the hosting layer vouches for it.
 *
 * Kept on a waiver and on a code-of-conduct acceptance as part of the forensic
 * record of who signed, and the key the public forms' rate limit counts by
 * (`src/lib/rate-limit.ts`). Pure, so it is testable without a request
 * context: the caller hands over a header getter.
 *
 * `cf-connecting-ip` first, deliberately. The site sits behind Cloudflare,
 * which sets that header itself and overwrites any copy the caller sent, but
 * which APPENDS to an `x-forwarded-for` the caller supplied. So the first
 * `x-forwarded-for` entry is whatever the caller wanted it to be. Until #52
 * this read that entry first, which let a script write any address it liked
 * into a waiver's record, and would have let it give itself a fresh address
 * per request against the rate limit. The other two headers remain as
 * fallbacks for a server with no Cloudflare in front (local development, the
 * end-to-end stack).
 */
export function clientIp(getHeader: (name: string) => string | undefined): string | null {
  const cf = getHeader("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const fwd = getHeader("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return getHeader("x-real-ip")?.trim() || null;
}
