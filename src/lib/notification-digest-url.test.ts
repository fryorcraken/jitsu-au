// The nightly digest's destination has to be the site's own origin.
//
// `private.run_notification_digest()` POSTs to a URL that is a literal in its
// SQL body, so it cannot read `SITE_ORIGIN` the way the app does. When the two
// drift apart the failure is silent: in October 2026 the site moved to
// utsjitsu.com.au, jitsu.au started redirecting, a cross-host redirect dropped
// the digest's bearer token, the endpoint answered 401 every night, and pg_cron
// recorded every run as a success (docs/notifications.md, "The October domain
// move"). This test is the only thing that ties the two together, so a change
// that moves one without the other fails here instead of in nobody's inbox.
//
// It reads the migration FILES. It proves the newest body this repo would
// install points at the right host, not that it has been applied to the live
// database: docs/database-changes.md's apply gate still owns that.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SITE_ORIGIN } from "./seo";

const MIGRATIONS = join(import.meta.dirname, "..", "..", "supabase", "migrations");

/** The URL literal in the newest migration that (re)defines the digest function. */
function newestDigestUrl(): { file: string; url: string | null } {
  const bodies = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => ({ file, sql: readFileSync(join(MIGRATIONS, file), "utf8") }))
    .filter(({ sql }) =>
      /CREATE OR REPLACE FUNCTION private\.run_notification_digest\(\)/.test(sql),
    );
  const newest = bodies.at(-1);
  if (!newest) throw new Error("no migration defines private.run_notification_digest()");
  return { file: newest.file, url: /url := '([^']+)'/.exec(newest.sql)?.[1] ?? null };
}

describe("the nightly digest's destination", () => {
  it("is the site's own origin, so no redirect can drop its token", () => {
    const { file, url } = newestDigestUrl();
    expect(url, `${file} has no inlined url := '...' literal`).not.toBeNull();
    expect(url).toBe(`${SITE_ORIGIN}/api/notifications/digest`);
  });
});
