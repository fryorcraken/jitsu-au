// The rules that keep every email going through one sender.
//
// `src/lib/send-email.server.ts` is the only module allowed to call Lovable's
// send API, and `src/lib/email-sender.ts` the only one that spells who an
// email is from. Before that, seven modules each carried their own copy of
// both, so a change that had to reach every email had to be made seven times.
// A new email module that calls the library directly still works and still
// passes every other test; it just quietly misses whatever the shared sender
// does for everybody else. So the rules are checked here rather than trusted.
// `docs/emails.md` lists what goes through the seam.

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(process.cwd());
const SENDER = "src/lib/send-email.server.ts";
const IDENTITY = "src/lib/email-sender.ts";
/**
 * Supabase Auth's emails are sent by Lovable's `createAuthEmailHandler`, which
 * sends from inside its own code and so cannot go through `sendEmail`. This
 * route may take that one function from the library, and nothing else.
 */
const AUTH_WEBHOOK = "src/routes/lovable/email/auth/webhook.ts";

/** Every source file under src/, tests excluded (they mock the library). */
function sourceFiles(): string[] {
  return readdirSync(join(ROOT, "src"), { recursive: true })
    .map((entry) => `src/${String(entry).split("\\").join("/")}`)
    .filter((file) => /\.(ts|tsx)$/.test(file) && !/\.test\.tsx?$/.test(file))
    .sort();
}

function read(file: string): string {
  return readFileSync(join(ROOT, file), "utf8");
}

/**
 * Any mention of the library as a module specifier, in any quote style, with
 * any whitespace around it: `from "..."`, `import('...')`, `require(...)`, and
 * a dynamic import Prettier has wrapped onto its own line.
 */
const LIBRARY = /["'`]@lovable\.dev\/email-js["'`]/;

/** The names a file takes from the library in a static `import { ... } from`. */
function importedNames(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(
    /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["'`]@lovable\.dev\/email-js["'`]/g,
  )) {
    for (const part of m[1].split(",")) {
      const name = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0];
      if (name) names.push(name);
    }
  }
  return names;
}

describe("sending email", () => {
  it("has source files to check", () => {
    // A path change that found nothing would turn every rule below into a
    // test that passes by having no work to do.
    expect(sourceFiles().length).toBeGreaterThan(50);
    expect(sourceFiles()).toEqual(expect.arrayContaining([SENDER, IDENTITY, AUTH_WEBHOOK]));
  });

  it("goes through sendEmail, never the Lovable email library directly", () => {
    const offenders = sourceFiles().filter(
      (file) => file !== SENDER && file !== AUTH_WEBHOOK && LIBRARY.test(read(file)),
    );
    expect(offenders, `send through sendEmail in ${SENDER} instead (docs/emails.md)`).toEqual([]);
  });

  it("lets the auth webhook take createAuthEmailHandler from the library, and nothing else", () => {
    const source = read(AUTH_WEBHOOK);
    // Every mention of the library in the file must be the one static import
    // checked below: no second import, no dynamic import, no require.
    expect(source.match(new RegExp(LIBRARY.source, "g"))?.length).toBe(1);
    expect(importedNames(source)).toEqual(["createAuthEmailHandler"]);
  });

  it("spells the sending domain and the club's email name in one place", () => {
    const offenders = sourceFiles().filter((file) => {
      if (file === IDENTITY) return false;
      const source = read(file);
      return source.includes("notify.jitsu.au") || /const SITE_NAME\s*=/.test(source);
    });
    expect(offenders, `import SENDER_DOMAIN / FROM / SITE_NAME from ${IDENTITY}`).toEqual([]);
  });
});
