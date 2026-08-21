// Which Supabase URLs this repo's tooling is allowed to point a SERVICE-ROLE
// client at.
//
// Three programs make service-role calls against a seeded local stack — the
// seed itself and the end-to-end tests (which take the pull request's
// screenshots as they go) — and every one of them bypasses RLS, while GoTrue's `generate_link` CREATES an account that
// does not exist. So the whole thing standing between a mistyped environment
// variable and fixture members in the club's real database is this predicate.
//
// Each caller keeps its own refusal message, because "refusing to seed" and
// "refusing to sign in" are different sentences to read at 11pm. What lives
// here is the RULE, so widening it (an IPv6 alias, a CI hostname) cannot be
// done for one caller and forgotten for the other two.
//
// TypeScript, and imported from both `.mjs` scripts and the Playwright specs:
// bun and Playwright both load TS directly.

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** True only for a Supabase URL served from this machine. Throws on a non-URL. */
export function isLocalSupabase(url: string): boolean {
  return LOOPBACK_HOSTS.has(new URL(url).hostname);
}
