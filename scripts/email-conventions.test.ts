// The rule that keeps every email going through one sender.
//
// `src/lib/email-send.server.ts` is the only module allowed to talk to the
// Lovable send API and the only one that spells the sender identity. Before it
// existed, seven modules each carried their own copy of both, so a change that
// had to reach every email (a reply-to address, a resend) had to be made seven
// times. A new email module that calls `sendLovableEmail` directly still works
// and still passes every other test; it just quietly misses whatever the shared
// sender does for everybody else. So the rule is checked here rather than
// trusted. `docs/emails.md` lists what goes through the seam.

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(process.cwd());
const SENDER = "src/lib/email-send.server.ts";
/**
 * Supabase Auth's emails are sent by Lovable's `createAuthEmailHandler`, which
 * does its own sending and so cannot go through `sendClubEmail`. Its identity
 * still comes from the shared module (the sending-domain rule below).
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

describe("sending email", () => {
  it("has source files to check", () => {
    // A path change that found nothing would turn every rule below into a
    // test that passes by having no work to do.
    expect(sourceFiles().length).toBeGreaterThan(50);
    expect(sourceFiles()).toContain(SENDER);
  });

  it("goes through sendClubEmail, never the Lovable email library directly", () => {
    // The import, not one function name: any other way into the library
    // (a second auth handler, a future batch send) skips the seam just as well.
    const offenders = sourceFiles().filter(
      (file) =>
        file !== SENDER &&
        file !== AUTH_WEBHOOK &&
        /from "@lovable\.dev\/email-js"|import\("@lovable\.dev\/email-js"\)/.test(read(file)),
    );
    expect(
      offenders,
      `send through sendClubEmail in ${SENDER} instead — see docs/emails.md`,
    ).toEqual([]);
  });

  it("spells the sending domain in one place", () => {
    // The auth webhook uses createAuthEmailHandler, which cannot go through
    // sendClubEmail, so this is what keeps its `from` on the shared identity.
    const offenders = sourceFiles().filter(
      (file) => file !== SENDER && read(file).includes("notify.jitsu.au"),
    );
    expect(offenders, `import FROM / SENDER_DOMAIN from ${SENDER} instead`).toEqual([]);
  });
});
