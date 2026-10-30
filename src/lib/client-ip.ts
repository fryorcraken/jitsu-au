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
 * per request against the rate limit.
 *
 * ⚠️ With one exception, which is not a guess about Lovable but a documented
 * Cloudflare behaviour: when a Worker makes a request to another Worker or zone
 * on Cloudflare, that request arrives with `cf-connecting-ip` set to the
 * WORKER's address, which Cloudflare allocates from `2a06:98c0::/29`. Lovable
 * runs a layer in front of this app (it rewrites response headers; see
 * `security-headers.ts`), and nobody outside Lovable can say whether that layer
 * is such a request. If it is, every visitor would arrive with the same
 * address, the rate limit would count the whole world as one network, and
 * every waiver would record the proxy. So an address in that range is treated
 * as "not the visitor" and the `x-forwarded-for` chain is read instead, which
 * is what production recorded until #52 and is known to tell signers apart (16
 * distinct addresses across 17 online waivers, read on 2026-10-30). That path
 * can be spoofed, which is the price of not collapsing everyone into one.
 *
 * The other headers remain as fallbacks for a server with no Cloudflare in
 * front (local development, the end-to-end stack).
 */
export function clientIp(getHeader: (name: string) => string | undefined): string | null {
  const cf = getHeader("cf-connecting-ip")?.trim();
  if (cf && !isCloudflareWorkerAddress(cf)) return cf;
  const fwd = getHeader("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return getHeader("x-real-ip")?.trim() || cf || null;
}

/**
 * Inside `2a06:98c0::/29`, the block Cloudflare gives Worker subrequests: the
 * first group is 2a06 and the second 98c0 to 98c7.
 */
export function isCloudflareWorkerAddress(ip: string): boolean {
  return /^2a06:98c[0-7]:/i.test(ip.trim());
}
