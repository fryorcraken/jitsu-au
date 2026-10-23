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

// Any spelling Postgres accepts for (re)defining the function: either case,
// with or without OR REPLACE, quoted identifiers, any whitespace. A body this
// misses would be silently skipped, and the test would pass against an older
// one, which is the exact failure it exists to catch.
const DEFINES_DIGEST =
  /create\s+(?:or\s+replace\s+)?function\s+"?private"?\s*\.\s*"?run_notification_digest"?\s*\(/gi;

/** Every definition of the digest function, in apply order, with its own body. */
function digestBodies(): { file: string; body: string }[] {
  const found: { file: string; body: string }[] = [];
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    for (const m of sql.matchAll(DEFINES_DIGEST)) {
      // The body runs from the opening $$ after the header to the closing $$.
      // Reading the URL from inside it, not from anywhere in the file, keeps a
      // second net.http_post elsewhere in the same file from being mistaken
      // for the digest's.
      const open = sql.indexOf("$$", m.index);
      const close = open === -1 ? -1 : sql.indexOf("$$", open + 2);
      found.push({ file, body: close === -1 ? "" : sql.slice(open + 2, close) });
    }
  }
  return found;
}

describe("the nightly digest's destination", () => {
  it("is the site's own origin, so no redirect can drop its token", () => {
    const bodies = digestBodies();
    expect(bodies.length, "no migration defines private.run_notification_digest()").toBeGreaterThan(
      0,
    );
    const newest = bodies.at(-1)!;
    const url = /url\s*:=\s*'([^']+)'/i.exec(newest.body)?.[1] ?? null;
    expect(url, `${newest.file} has no inlined url := '...' in the function body`).not.toBeNull();
    expect(url, newest.file).toBe(`${SITE_ORIGIN}/api/notifications/digest`);
  });

  // Guards the scan itself: every body this repo has ever shipped is found,
  // including the ones written in other spellings, so a regression in the
  // pattern cannot quietly shrink what "newest" is chosen from.
  it("finds every historical definition of the function", () => {
    const files = digestBodies().map((b) => b.file);
    expect(files).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^20260807000000_/),
        expect.stringMatching(/^20260822120041_/),
        expect.stringMatching(/^20261023000000_/),
      ]),
    );
  });
});
